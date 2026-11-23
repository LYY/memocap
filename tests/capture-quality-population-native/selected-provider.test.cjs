const assert = require('node:assert/strict');
const test = require('node:test');
const { control } = require('./control.cjs');
const { selection, endpoint, memoryHTTP, upstream, tick } = require('./selected-provider-fixture.cjs');
const { caseLimits, createMeter, inventory } = require('./inventory.cjs');
function harness(options = {}) {
  const binding = selection(); const used = {}; const remote = upstream(options);
  const channel = control('private-token');
  channel.bind({ charge(key, amount = 1) {
    assert.ok((used[key] ?? 0) + amount <= (options.limits?.[key] ?? inventory().limits[key]), `budget_${key}`);
    options.charge?.(key, amount); used[key] = (used[key] ?? 0) + amount;
  } });
  assert.equal(typeof channel.bindProvider, 'function', 'missing selected-address handler binding');
  channel.bindProvider({ binding, limits: { ...caseLimits('queued-exit-zero'), ...options.caseLimits },
    session: (root) => root === 'observed-root', send: remote.send });
  const { providerWire } = require('./provider-wire.cjs');
  const fetch = providerWire({ socket: '/synthetic/control.sock', token: 'private-token', binding,
    root: () => 'observed-root' }, memoryHTTP(channel.handler, options.change));
  return { binding, used, remote, channel, fetch,
    request(body = '{}', signal) { return new Request(endpoint, { method: 'POST', body, signal,
      headers: { authorization: 'synthetic-provider-secret', 'content-type': 'application/json' } }); } };
}
test('selected parent route preserves original URL, Host, SNI, TLS checks and single-address lookup', async () => {
  const current = harness();
  const response = await current.fetch(current.request());
  assert.equal(await response.text(), 'data: ok\n\n');
  const { url, init, chunks } = current.remote.calls[0];
  assert.equal(String(url), endpoint); assert.equal(init.hostname, 'sub2api.big.zone');
  assert.equal(init.headers.host, 'sub2api.big.zone'); assert.equal(init.servername, 'sub2api.big.zone');
  assert.equal(init.rejectUnauthorized, true); assert.equal(init.checkServerIdentity, undefined);
  assert.equal(init.family, 4); assert.equal(init.autoSelectFamily, false);
  assert.notEqual(init.agent, require('node:https').globalAgent); assert.deepEqual(init.agent.options.proxyEnv, {});
  assert.equal(init.headers['accept-encoding'], 'identity');
  assert.equal(init.headers.authorization, 'synthetic-provider-secret'); assert.equal(Buffer.concat(chunks).toString(), '{}');
  init.lookup('sub2api.big.zone', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, '198.18.5.40'); assert.equal(family, 4);
  });
  init.lookup('sub2api.big.zone', { all: true }, (error, addresses) => {
    assert.equal(error, null); assert.deepEqual(addresses, [{ address: '198.18.5.40', family: 4 }]);
  });
  init.lookup('foreign.invalid', {}, (error) => assert.ok(error));
  assert.equal(current.used.provider_requests, 1); assert.equal(current.used.provider_request_bytes, 2);
  assert.equal(current.used.provider_response_bytes, 10); assert.equal(current.used.control_requests, 1);
  assert.equal(current.used.control_bytes, 12); current.channel.stop();
});
for (const [name, change] of [
  ['auth', (options) => ({ ...options, headers: { ...options.headers, authorization: 'wrong' } })],
  ['binding', (options) => ({ ...options, headers: { ...options.headers, 'x-memocap-selection': 'forged' } })],
  ['session', (options) => ({ ...options, headers: { ...options.headers, 'x-memocap-root': 'foreign' } })],
  ['destination', (options) => ({ ...options, path: '/provider/foreign' })],
]) test(`provider bridge rejects changed ${name} before HTTPS dispatch`, async () => {
  const current = harness({ change });
  await assert.rejects(current.fetch(current.request())); assert.equal(current.remote.calls.length, 0); current.channel.stop();
});
for (const dimension of ['provider_requests', 'provider_request_bytes', 'control_requests', 'control_bytes']) {
  test(`parent ${dimension} exhaustion blocks HTTPS before dispatch`, async () => {
    const current = harness({ limits: { [dimension]: 0 } });
    await assert.rejects(current.fetch(current.request())); assert.equal(current.remote.calls.length, 0); current.channel.stop();
  });
}
test('case request budget is enforced before dispatch even with remaining global budget', async () => {
  const current = harness({ caseLimits: { provider_requests: 1 } });
  await (await current.fetch(current.request())).text();
  await assert.rejects(current.fetch(current.request())); assert.equal(current.remote.calls.length, 1); current.channel.stop();
});
test('aggregate response quota refuses bytes before forwarding', async () => {
  const meter = createMeter({ mode: 'offline' }, 'offline');
  meter.charge('provider_response_bytes', 58195968);
  const current = harness({ charge: meter.charge });
  await assert.rejects(async () => (await current.fetch(current.request())).text());
  assert.equal(meter.snapshot().provider_response_bytes, 58195968); current.channel.stop();
});
test('response overflow errors and destroys upstream without a second dispatch', async () => {
  const body = ReadableChunks([Buffer.alloc(262144), Buffer.alloc(1)]);
  const current = harness({ body });
  await assert.rejects(async () => (await current.fetch(current.request())).arrayBuffer());
  await assert.rejects(current.fetch(current.request()));
  assert.equal(current.remote.calls.length, 1); assert.equal(body.destroyed, true);
  assert.ok(current.used.provider_response_bytes <= 262144); current.channel.stop();
});
function ReadableChunks(chunks) { return require('node:stream').Readable.from(chunks); }
for (const status of [302, 307, 401, 403]) test(`parent status ${status} is terminal with no redirect or retry`, async () => {
  const current = harness({ status });
  await assert.rejects(current.fetch(current.request())); await assert.rejects(current.fetch(current.request()));
  assert.equal(current.remote.calls.length, 1); current.channel.stop();
});
test('raw content encoding is rejected instead of decoded or billed as identity bytes', async () => {
  const current = harness({ headers: { 'content-encoding': 'gzip' } });
  await assert.rejects(current.fetch(current.request())); await assert.rejects(current.fetch(current.request()));
  assert.equal(current.used.provider_response_bytes ?? 0, 0); assert.equal(current.remote.calls.length, 1); current.channel.stop();
});
test('abort destroys pending parent request and cancels a late response', async () => {
  const current = harness({ late: true }); const abort = new AbortController();
  const pending = current.fetch(current.request('{}', abort.signal));
  await current.remote.started; abort.abort(); await assert.rejects(pending);
  await tick(); assert.equal(current.remote.request().destroyed, true);
  const late = current.remote.reply(); await tick(); assert.equal(late.destroyed, true); current.channel.stop();
});
test('consumer disconnect tears down upstream and makes first failure terminal', async () => {
  const body = new (require('node:stream').PassThrough)(); const current = harness({ body });
  const response = await current.fetch(current.request()); await response.body.cancel(); await tick();
  assert.equal(body.destroyed, true); assert.equal(current.remote.request().destroyed, true);
  await assert.rejects(current.fetch(current.request())); assert.equal(current.remote.calls.length, 1); current.channel.stop();
});
test('non-success provider status survives the child bridge without a retry', async () => {
  const current = harness({ status: 429 });
  const response = await current.fetch(current.request());
  assert.equal(response.status, 429); assert.equal(await response.text(), 'data: ok\n\n');
  assert.equal(current.remote.calls.length, 1); current.channel.stop();
});
test('certificate or connection error is terminal without another lookup or dispatch', async () => {
  const current = harness({ error: Object.assign(new Error('synthetic certificate failure'), { code: 'CERT_HAS_EXPIRED' }) });
  await assert.rejects(current.fetch(current.request())); await assert.rejects(current.fetch(current.request()));
  assert.equal(current.remote.calls.length, 1); current.channel.stop();
});
test('request overflow is blocked before the control channel or provider can dispatch', async () => {
  const current = harness();
  await assert.rejects(current.fetch(current.request('x'.repeat(262145))), { code: 'provider_request_body_limit' });
  assert.equal(current.used.control_requests ?? 0, 0); assert.equal(current.remote.calls.length, 0); current.channel.stop();
});
test('pinned Node helper also bounds its request before the injected HTTPS effect', async () => {
  const { pinnedFetch } = require('./selected-address.cjs'); const remote = upstream();
  await assert.rejects(pinnedFetch(selection(), remote.send)(new Request(endpoint, { method: 'POST', body: 'x'.repeat(262145) })),
    { code: 'provider_request_body_limit' });
  assert.equal(remote.calls.length, 0);
});
for (const [header, value] of [['host', 'foreign.invalid'], ['proxy-authorization', 'synthetic-proxy'],
  ['content-encoding', 'gzip'], ['accept-encoding', 'gzip'], ['connection', 'upgrade']]) {
  test(`forbidden ${header} cannot select another transport before effects`, async () => {
    const current = harness(); const request = current.request(); request.headers.set(header, value);
    await assert.rejects(current.fetch(request));
    assert.equal(current.used.control_requests ?? 0, 0); assert.equal(current.remote.calls.length, 0); current.channel.stop();
  });
}
test('parent rejects forged destination headers independently of the child adapter', async () => {
  const current = harness({ change: (options) => ({ ...options, headers: { ...options.headers,
    'x-memocap-provider-headers': JSON.stringify({ host: 'foreign.invalid' }) } }) });
  await assert.rejects(current.fetch(current.request())); assert.equal(current.remote.calls.length, 0); current.channel.stop();
});
test('JSON and provider traffic consume the same unchanged per-host control call ceiling', async () => {
  const current = harness(); const { wire } = require('./control.cjs');
  const rpc = wire('/synthetic/control.sock', 'private-token', memoryHTTP(current.channel.handler));
  for (let index = 0; index < 255; index++) await rpc('/ready');
  await (await current.fetch(current.request())).text();
  await assert.rejects(current.fetch(current.request()));
  assert.equal(current.used.control_requests, 256); assert.equal(current.remote.calls.length, 1); current.channel.stop();
});
