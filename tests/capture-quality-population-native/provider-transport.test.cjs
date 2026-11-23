const assert = require('node:assert/strict');
const test = require('node:test');
const { egress, correlation } = require('./egress.cjs');
const { inventory, caseLimits, createMeter } = require('./inventory.cjs');
const endpoint = 'https://example.invalid/responses';
const cap = 262144;
function fixture(transport, charge) {
  const used = {}; let calls = 0;
  const boundary = egress({ origin: 'http://127.0.0.1:4444', endpoints: [endpoint], session: (id) => id === 'child',
    charge: charge ?? ((key, amount = 1) => { used[key] = (used[key] ?? 0) + amount; }),
    transport: async (request) => { calls++; return transport(request); } });
  return { ...boundary, used, calls: () => calls };
}
function request(body, signal) {
  return new Request(endpoint, { method: body === undefined ? 'GET' : 'POST',
    headers: { [correlation]: 'child' }, body, signal, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) });
}

test('rejects request limit plus one before transport and stops subsequent dispatch', async () => {
  const boundary = fixture(() => new Response('ok'));
  await assert.rejects(boundary.provider(request('x'.repeat(cap + 1))), /provider_request_body_limit/);
  await assert.rejects(boundary.provider(request('small')), /provider_request_body_limit/);
  assert.equal(boundary.calls(), 0);
});

test('charges exact request and response limits before forwarding without changing status or headers', async () => {
  const boundary = fixture(async (outgoing) => {
    assert.equal(boundary.used.provider_request_bytes, cap);
    assert.equal(outgoing.headers.has(correlation), false);
    assert.equal(outgoing.redirect, 'manual');
    assert.equal((await outgoing.arrayBuffer()).byteLength, cap);
    return new Response('x'.repeat(cap), { status: 201, headers: { 'content-type': 'text/event-stream', 'x-test': 'kept' } });
  });
  const response = await boundary.provider(request('y'.repeat(cap)));
  assert.equal((await response.arrayBuffer()).byteLength, cap);
  assert.equal(response.status, 201); assert.equal(response.headers.get('x-test'), 'kept');
  assert.equal(boundary.used.provider_response_bytes, cap);
});

test('response overflow errors during consumption, cancels source, and prevents second dispatch', async () => {
  let cancelled = 0; let pulls = 0;
  const boundary = fixture(() => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(pulls === 1 ? cap : 1)); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 })));
  const response = await boundary.provider(request());
  const reader = response.body.getReader();
  assert.equal((await reader.read()).value.byteLength, cap);
  assert.equal(boundary.used.provider_response_bytes, cap);
  await assert.rejects(reader.read(), /provider_response_body_limit/);
  await assert.rejects(boundary.provider(request()), /provider_response_body_limit/);
  assert.equal(cancelled, 1); assert.equal(boundary.calls(), 1); assert.equal(pulls, 2);
});

test('counts chunked multibyte SSE bytes rather than decoded characters', async () => {
  const bytes = new TextEncoder().encode(`${'界'.repeat(87381)}ab`);
  let offset = 0;
  const boundary = fixture(() => new Response(new ReadableStream({ pull(controller) {
    const end = Math.min(offset + 4096, bytes.length); controller.enqueue(bytes.subarray(offset, end)); offset = end;
    if (offset === bytes.length) controller.close();
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects((await boundary.provider(request())).text(), /provider_response_body_limit/);
  assert.ok(boundary.used.provider_response_bytes <= cap); assert.equal(boundary.calls(), 1);
  assert.equal(boundary.used.provider_response_bytes, 262144);
});

for (const direction of ['request', 'response']) test(`cumulative ${direction} overflow is terminal before more bytes forward`, async () => {
  const meter = createMeter({ mode: 'offline' }, 'offline');
  const dimension = `provider_${direction}_bytes`;
  meter.charge(dimension, inventory().limits[dimension] - 2);
  const boundary = fixture(() => new Response('abc'), meter.charge);
  const action = async () => { const response = await boundary.provider(request(direction === 'request' ? 'abc' : undefined)); await response.text(); };
  await assert.rejects(action(), new RegExp(`budget_${dimension}`));
  await assert.rejects(boundary.provider(request()), new RegExp(`budget_${dimension}`));
  assert.equal(boundary.calls(), direction === 'request' ? 0 : 1);
  assert.equal(meter.snapshot()[dimension], inventory().limits[dimension] - 2);
});

test('provider aggregate dimensions equal the sum of per-case finite reservations', () => {
  const report = inventory();
  for (const dimension of ['provider_request_bytes', 'provider_response_bytes']) {
    assert.equal(report.limits[dimension], 222 * cap);
    assert.equal(report.cases.reduce((sum, row) => sum + caseLimits(row.id)[dimension], 0), report.limits[dimension]);
  }
});

test('GET and no-body response charge zero body bytes', async () => {
  const boundary = fixture(() => new Response(null, { status: 204 }));
  assert.equal((await boundary.provider(request())).status, 204);
  assert.equal(boundary.used.provider_request_bytes ?? 0, 0);
  assert.equal(boundary.used.provider_response_bytes ?? 0, 0);
  assert.equal(boundary.used.provider_requests, 1);
});

test('response stream error remains observable and stops future dispatch', async () => {
  const boundary = fixture(() => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('synthetic_stream_error')); } })));
  await assert.rejects((await boundary.provider(request())).text(), /synthetic_stream_error/);
  await assert.rejects(boundary.provider(request()), /provider_response_unknown/);
  assert.equal(boundary.calls(), 1);
});

test('abort cancels a pending response read and transport signal without another dispatch', { timeout: 500 }, async () => {
  const controller = new AbortController(); let signal; let cancelled = 0;
  const boundary = fixture((outgoing) => { signal = outgoing.signal; return new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() { cancelled++; },
  })); });
  const response = await boundary.provider(request(undefined, controller.signal));
  const reading = response.text(); controller.abort();
  await assert.rejects(reading, /provider_aborted/);
  assert.equal(signal.aborted, true); assert.equal(cancelled, 1);
  await assert.rejects(boundary.provider(request()), /provider_aborted/);
});

test('consumer cancellation stops provider stream and future dispatch', async () => {
  let cancelled = 0;
  const boundary = fixture(() => new Response(new ReadableStream({ cancel() { cancelled++; } })));
  const response = await boundary.provider(request());
  await response.body.cancel();
  await assert.rejects(boundary.provider(request()), /provider_response_cancelled/);
  assert.equal(cancelled, 1);
});

test('transport rejection is terminal and never retried', async () => {
  const boundary = fixture(() => { throw new Error('synthetic_transport_error'); });
  await assert.rejects(boundary.provider(request()), /synthetic_transport_error/);
  await assert.rejects(boundary.provider(request()), /provider_dispatch_unknown/);
  assert.equal(boundary.calls(), 1);
});

test('chunked oversized request is cancelled before transport even without content-length', async () => {
  let pulls = 0; let cancelled = 0;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(++pulls === 1 ? cap : 1)); },
    cancel() { cancelled++; } }, { highWaterMark: 0 });
  const boundary = fixture(() => assert.fail('oversized request reached transport'));
  await assert.rejects(boundary.provider(request(body)), /provider_request_body_limit/);
  assert.equal(pulls, 2); assert.equal(cancelled, 1); assert.equal(boundary.used.provider_request_bytes, cap);
});

test('request stream failure stops future dispatch before any transport', async () => {
  const boundary = fixture(() => assert.fail('failed request reached transport'));
  await assert.rejects(boundary.provider(request(new ReadableStream({ pull(controller) {
    controller.error(new Error('request_source_error'));
  } }))), /request_source_error/);
  await assert.rejects(boundary.provider(request()), /provider_request_unknown/);
  assert.equal(boundary.calls(), 0);
});

test('aborted pending request cancels its source without transport', async () => {
  const controller = new AbortController(); let cancelled = 0;
  const boundary = fixture(() => assert.fail('aborted request reached transport'));
  const pending = boundary.provider(request(new ReadableStream({ cancel() { cancelled++; } }), controller.signal));
  controller.abort(); await assert.rejects(pending, /provider_aborted/);
  assert.equal(cancelled, 1); assert.equal(boundary.calls(), 0);
});

test('abort settles transport that ignores signal and cancels a late response', async () => {
  let resolve; let cancelled = 0; let entered;
  const started = new Promise((done) => { entered = done; });
  const boundary = fixture(() => { entered(); return new Promise((done) => { resolve = done; }); });
  const controller = new AbortController(); const pending = boundary.provider(request(undefined, controller.signal));
  await started; controller.abort(); await assert.rejects(pending, /provider_aborted/);
  resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await new Promise((done) => setImmediate(done));
  assert.equal(cancelled, 1); assert.equal(boundary.calls(), 1);
});

test('response applies backpressure instead of draining unconsumed provider SSE', async () => {
  let pulls = 0;
  const boundary = fixture(() => new Response(new ReadableStream({ pull(controller) {
    pulls++; controller.enqueue(new Uint8Array([65]));
  } }, { highWaterMark: 0 })));
  const response = await boundary.provider(request());
  assert.equal(pulls, 0); const reader = response.body.getReader(); await reader.read();
  assert.equal(pulls, 1); assert.equal(boundary.used.provider_response_bytes, 1); await reader.cancel();
});

for (const status of [300, 301, 302, 307, 308, 399, 401, 403]) test(`status ${status} cancels the body and preserves the first terminal reason`, async () => {
  let cancelled = 0;
  const boundary = fixture(() => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status }));
  const reason = [401, 403].includes(status) ? /permission_denied/ : /unexpected_redirect/;
  await assert.rejects(boundary.provider(request()), reason);
  await assert.rejects(boundary.provider(request()), reason);
  assert.equal(cancelled, 1); assert.equal(boundary.calls(), 1);
});

test('exact destination and observed session remain mandatory; loopback uses no provider reservation', async () => {
  const boundary = fixture(() => new Response(null, { status: 204 }));
  await assert.rejects(boundary.provider(new Request(`${endpoint}/foreign`, { headers: { [correlation]: 'child' } })), /unexpected_destination/);
  await assert.rejects(boundary.provider(new Request(endpoint, { headers: { [correlation]: 'foreign' } })), /provider_session_unobserved/);
  assert.equal(boundary.calls(), 0);
  await boundary.global('http://127.0.0.1:4444/session');
  assert.deepEqual(boundary.used, {}); assert.equal(boundary.calls(), 1);
});

test('stopped provider permits actual SDK owned cleanup through the same egress only', async () => {
  const { createOpencodeClient } = await import('@opencode-ai/sdk');
  const local = []; const used = {}; const started = Promise.withResolvers(); let calls = 0;
  const origin = 'http://127.0.0.1:4444';
  const boundary = egress({ origin, endpoints: [endpoint], session: (id) => ['root', 'child:owned'].includes(id),
    charge(key, amount = 1) { used[key] = (used[key] ?? 0) + amount; },
    transport: async (outgoing) => { local.push([outgoing.method, new URL(outgoing.url).pathname]); return Response.json(true); },
    providerTransport() { calls++; started.resolve(); return new Promise(() => {}); } });
  const sdk = createOpencodeClient({ baseUrl: origin, fetch: boundary.global, throwOnError: true });
  const controller = new AbortController();
  const pending = boundary.provider(new Request(endpoint, { headers: { [correlation]: 'root' }, signal: controller.signal }));
  await started.promise; controller.abort(); await assert.rejects(pending, /provider_aborted/);
  const before = structuredClone(used);
  for (const action of [() => sdk.session.create({ body: {} }), () => sdk.session.update({ path: { id: 'root' }, body: {} }),
    () => sdk.session.prompt({ path: { id: 'root' }, body: { parts: [] } }), () => sdk.config.get(),
    () => sdk.session.abort({ path: { id: 'foreign' } }), () => sdk.session.delete({ path: { id: 'foreign' } })]) {
    await assert.rejects(action, /provider_aborted/);
  }
  for (const [method, route] of [['GET', '/session/root/abort'], ['DELETE', '/session/root/abort'], ['POST', '/session/root'],
    ['DELETE', '/session/root?directory=foreign'], ['POST', '/session/root/abort?x=1'], ['DELETE', '/session/%72oot'],
    ['DELETE', '/session/root%2Fforeign'], ['DELETE', '/session/root%252Fforeign'], ['DELETE', '/session/%ZZ'],
    ['DELETE', '/session/root/'], ['DELETE', '/session/root#extra'], ['DELETE', '/session/root/message']]) {
    await assert.rejects(boundary.global(`${origin}${route}`, { method }), /provider_aborted/);
  }
  await assert.rejects(boundary.global('http://127.0.0.1:4445/session/root', { method: 'DELETE' }), /provider_aborted/);
  await assert.rejects(boundary.global('https://foreign.invalid/session/root/abort', { method: 'POST' }), /provider_aborted/);
  await assert.rejects(boundary.global(`${origin}/session/root/abort`, { method: 'POST', body: '{}' }), /provider_aborted/);
  assert.deepEqual(local, []);
  for (const id of ['child:owned', 'root']) {
    assert.equal((await sdk.session.abort({ path: { id } })).data, true);
    assert.equal((await sdk.session.delete({ path: { id } })).data, true);
  }
  assert.deepEqual(local, [['POST', '/session/child%3Aowned/abort'], ['DELETE', '/session/child%3Aowned'],
    ['POST', '/session/root/abort'], ['DELETE', '/session/root']]);
  await assert.rejects(boundary.provider(request()), /provider_aborted/);
  assert.equal(calls, 1); assert.deepEqual(used, before);
});
