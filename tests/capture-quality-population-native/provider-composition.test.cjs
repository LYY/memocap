const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable, Writable, PassThrough } = require('node:stream');
const { control, wire } = require('./control.cjs');
const { install } = require('./plugin-runtime.cjs');
const { createFixture } = require('./fixture.cjs');
const { caseLimits, inventory } = require('./inventory.cjs');
const { sources } = require('./authorization.cjs');
const { selection, endpoint, memoryHTTP, upstream, tick } = require('./selected-provider-fixture.cjs');

async function composed() {
  const binding = selection(); const used = {}; const remote = upstream(); const locals = []; const sent = [];
  const channel = control('synthetic-private');
  channel.bind({ charge(key, amount = 1) {
    assert.ok((used[key] ?? 0) + amount <= inventory().limits[key]); used[key] = (used[key] ?? 0) + amount;
  }, user() {}, record() {} });
  channel.bindProvider({ binding, limits: caseLimits('queued-exit-zero'), session: (id) => id === 'root', send: remote.send });
  const rpc = wire('/synthetic/control.sock', 'synthetic-private', memoryHTTP(channel.handler));
  const hooks = await install({ serverUrl: new URL('http://127.0.0.1:4444'), client: { session: {} } }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: sources().digest, approval_id: 'offline-selection-only',
    privateRoot: '/synthetic', paths: { database: '/synthetic/database' }, case: 'queued-exit-zero',
    socket: '/synthetic/control.sock', token: 'synthetic-private', endpoints: [endpoint], network_binding: binding,
  }, { rpc: async (route, body) => { sent.push({ route, body }); return rpc(route, body); },
    fetch: async (request) => { locals.push(request.url); return new Response('local'); },
    providerSend: memoryHTTP(channel.handler),
    native: { initialize: async () => `repository:${'c'.repeat(64)}`, invoke() {}, uncertain: () => false },
    fixture: (input, seam) => createFixture(input, { ...seam, factory: async () => ({ dispose() {} }) }) });
  const config = { provider: { 'openai-b1': { options: {} } } };
  await hooks.config(config);
  const pumping = hooks.qualityPump();
  await channel.ready; await channel.call('bind', { review: false, user: 'fixture', operations: [] });
  await hooks['chat.message']({ sessionID: 'root' }, { message: { id: 'user', sessionID: 'root' }, parts: [] });
  const headers = { headers: {} }; await hooks['chat.headers']({ sessionID: 'root' }, headers);
  return { used, remote, locals, sent, hooks, channel, pumping, headers: headers.headers,
    fetch: config.provider['openai-b1'].options.fetch, config,
    async close() { await channel.call('close', {}); await pumping; channel.stop(); } };
}

test('installed provider fetch traverses the existing handler and bills parent dimensions exactly once', async () => {
  const current = await composed();
  try {
    const response = await current.fetch(endpoint, { method: 'POST', headers: current.headers, body: '{}' });
    assert.equal(await response.text(), 'data: ok\n\n');
    await current.channel.call('wait', { review: false });
    assert.equal(current.used.provider_requests, 1); assert.equal(current.used.provider_request_bytes, 2);
    assert.equal(current.used.provider_response_bytes, 10); assert.equal(current.remote.calls.length, 1);
    assert.equal(current.locals.length, 0); assert.equal(current.config.provider['openai-b1'].options.maxRetries, 0);
    for (const message of current.sent.filter(({ route }) => ['/observations', '/result'].includes(route))) {
      assert.ok(!Object.keys(message.body.charges ?? {}).some((key) => key.startsWith('provider_')));
    }
    await assert.rejects(current.fetch('https://foreign.invalid/v1/responses', { method: 'POST', headers: current.headers, body: '{}' }));
    assert.equal(current.remote.calls.length, 1);
  } finally { await current.close(); }
});

test('parent refuses child-reported provider charges after bridge precharge instead of billing twice', async () => {
  const current = await composed();
  try {
    await (await current.fetch(endpoint, { method: 'POST', headers: current.headers, body: '{}' })).text();
    const rpc = wire('/synthetic/control.sock', 'synthetic-private', memoryHTTP(current.channel.handler));
    await assert.rejects(rpc('/observations', { charges: { provider_requests: 1 } }), { code: 'provider_charge_custody' });
    assert.equal(current.used.provider_requests, 1);
  } finally { await current.close(); }
});

test('provider backpressure keeps a paused downstream from draining the raw upstream', async () => {
  let emitted = 0;
  const body = new Readable({ highWaterMark: 1024, read() { emitted++; this.push(Buffer.alloc(1024)); } });
  const binding = selection(); const remote = upstream({ body }); const channel = control('private');
  channel.bind({ charge() {} }); channel.bindProvider({ binding, limits: caseLimits('queued-exit-zero'), session: () => true, send: remote.send });
  const { providerWire } = require('./provider-wire.cjs');
  const fetch = providerWire({ socket: '/synthetic', token: 'private', binding, root: () => 'root' }, memoryHTTP(channel.handler));
  const response = await fetch(new Request(endpoint, { method: 'POST', body: '{}' }));
  await tick(); const paused = emitted; await tick();
  assert.ok(paused < 128, `unbounded upstream read ahead: ${paused}`); assert.equal(emitted, paused);
  await response.body.cancel(); await tick(); assert.equal(body.destroyed, true); channel.stop();
});

test('bridge rejects outer encoded control body before dispatch', async () => {
  const { providerWire } = require('./provider-wire.cjs'); const binding = selection(); const remote = upstream();
  const channel = control('private'); channel.bind({ charge() {} });
  channel.bindProvider({ binding, limits: caseLimits('queued-exit-zero'), session: () => true, send: remote.send });
  const fetch = providerWire({ socket: '/synthetic', token: 'private', binding, root: () => 'root' },
    memoryHTTP(channel.handler, (options) => ({ ...options, headers: { ...options.headers, 'content-encoding': 'gzip' } })));
  await assert.rejects(fetch(new Request(endpoint, { method: 'POST', body: '{}' })));
  assert.equal(remote.calls.length, 0); channel.stop();
});

test('pending control response abort destroys the request and any later control response', async () => {
  const { providerWire } = require('./provider-wire.cjs'); const controller = new AbortController(); let reply; let outgoing;
  const fetch = providerWire({ socket: '/synthetic', token: 'private', binding: selection(), root: () => 'root' },
    (_options, receive) => { reply = receive; outgoing = new Writable({ write(_chunk, _encoding, done) { done(); } }); return outgoing; });
  const pending = fetch(new Request(endpoint, { method: 'POST', body: '{}', signal: controller.signal }));
  await tick(); controller.abort(); await assert.rejects(pending); assert.equal(outgoing.destroyed, true);
  const late = new PassThrough(); reply(late); assert.equal(late.destroyed, true);
});
test('raw encoded control response is rejected before exposing its bytes', async () => {
  const { providerWire } = require('./provider-wire.cjs'); let body; let options;
  const fetch = providerWire({ socket: '/synthetic', token: 'private', binding: selection(), root: () => 'root' },
    (supplied, receive) => {
      options = supplied;
      return new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) {
        body = new PassThrough(); body.statusCode = 200; body.on('error', () => {});
        body.headers = { 'x-memocap-provider': 'stream', 'x-memocap-provider-status': '200', 'content-encoding': 'gzip' };
        receive(body); done();
      } });
    });
  await assert.rejects(fetch(new Request(endpoint, { method: 'POST', body: '{}' })), { code: 'provider_response_encoding' });
  assert.equal(options.headers['accept-encoding'], 'identity'); assert.equal(body.destroyed, true);
});
