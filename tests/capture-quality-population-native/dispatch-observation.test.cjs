const test = require('node:test');
const assert = require('node:assert/strict');
const { control } = require('./control.cjs');
const { providerWire } = require('./provider-wire.cjs');
const { selection, endpoint, memoryHTTP, upstream } = require('./selected-provider-fixture.cjs');
const { caseLimits } = require('./inventory.cjs');
const { pinnedFetch } = require('./selected-address.cjs');
function harness(options = {}) {
  const events = []; const binding = selection(); const remote = upstream(options); const channel = control('private');
  channel.bind({ charge() {}, user() {}, record(event) { events.push(event); } });
  channel.bindProvider({ binding, session: (root) => root === 'root', limits: caseLimits('queued-exit-zero'),
    send: options.send ?? remote.send });
  const fetch = providerWire({ socket: '/synthetic', token: 'private', binding, root: () => 'root' }, memoryHTTP(channel.handler));
  return { events, remote, channel, async run() {
    const { wire } = require('./control.cjs');
    await wire('/synthetic', 'private', memoryHTTP(channel.handler))('/boundary', { method: 'user', value: { message: { sessionID: 'root', id: 'user' } } });
    return fetch(new Request(endpoint, { method: 'POST', body: '{}' }));
  } };
}
test('actual dispatch returns private correlation and observed transport completion without retaining body or headers', async () => {
  const current = harness(); const response = await current.run(); await response.text();
  const [start, finish] = current.events;
  assert.equal(start.kind, 'provider.dispatch'); assert.equal(finish.kind, 'provider.finished');
  assert.equal(response.headers.get('x-memocap-dispatch-id'), start.dispatch_id);
  assert.equal(finish.dispatch_id, start.dispatch_id); assert.equal(finish.outcome, 'response');
  assert.equal(start.root, 'root'); assert.equal(start.user, 'user');
  assert.equal(start.headers, undefined); assert.equal(start.body, undefined); current.channel.stop();
});
test('failed HTTPS invocation is an attempted dispatch with unknown usage', async () => {
  const current = harness({ send() { throw new Error('synthetic transport failure'); } });
  await assert.rejects(current.run());
  assert.deepEqual(current.events.map(({ kind }) => kind), ['provider.dispatch', 'provider.finished']);
  assert.equal(current.events[1].outcome, 'failed'); assert.equal(current.events[1].usage, undefined); current.channel.stop();
});
test('before-dispatch blocked admission is not an HTTP attempt', async () => {
  const current = harness(); current.channel.stop(); await assert.rejects(current.run());
  assert.equal(current.events.length, 0); assert.equal(current.remote.calls.length, 0);
});
test('throwing dispatch recorder cannot report an invocation that never happened', async () => {
  const events = []; const remote = upstream({ late: true });
  const fetch = pinnedFetch(selection(), remote.send, () => (event) => {
    events.push(event); if (event.kind === 'provider.dispatch') throw new Error('dispatch sink rejected');
  });
  await assert.rejects(fetch(new Request(endpoint, { method: 'POST', body: '{}' })), { code: 'provider_observation_failed' });
  assert.equal(remote.calls.length, 1);
  assert.deepEqual(events.map(({ kind }) => kind), ['provider.dispatch', 'provider.finished']);
  assert.equal(events[1].outcome, 'failed'); assert.equal(remote.request().destroyed, true);
});
test('observer preparation failure precedes invocation without transport evidence', async () => {
  const remote = upstream();
  const fetch = pinnedFetch(selection(), remote.send, () => { throw new Error('observer preparation rejected'); });
  await assert.rejects(fetch(new Request(endpoint, { method: 'POST', body: '{}' })), { code: 'provider_observation_failed' });
  assert.equal(remote.calls.length, 0);
});
const { Readable, PassThrough } = require('node:stream');
function terminal(usage = { input_tokens: 10, output_tokens: 2 }, type = 'response.completed') {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: 1, response: { usage } })}\n\n`;
}
async function observed(chunks, headers) {
  const events = []; const remote = upstream({ body: Readable.from(chunks), headers });
  const response = await pinnedFetch(selection(), remote.send, () => (event) => events.push(event))(
    new Request(endpoint, { method: 'POST', body: '{}' }));
  return { response, events, remote };
}
for (const newline of ['\n', '\r\n', '\r']) test(`terminal usage survives byte boundaries and ${JSON.stringify(newline)} framing without changing bytes`, async () => {
  const text = ': 中文\n\ndata: {"type":"response.completed",\ndata: "response":{"usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":0}}}}\n\n';
  const bytes = Buffer.from(text.replaceAll('\n', newline));
  const current = await observed([...bytes].map((byte) => Buffer.from([byte])));
  assert.equal(current.events.length, 1);
  assert.deepEqual(Buffer.from(await current.response.arrayBuffer()), bytes);
  const finish = current.events[1];
  assert.equal(finish.terminal.status, 'completed'); assert.equal(finish.terminal.dialect, 'responses');
  assert.deepEqual(finish.terminal.usage.tokens, { input: 10, output: 2, reasoning: null, cache_read: 0, cache_write: null });
  assert.deepEqual(finish.terminal.usage.token_states, { input: 'observed', output: 'observed', reasoning: 'absent', cache_read: 'observed', cache_write: 'absent' });
  assert.equal(JSON.stringify(current.events).includes('中文'), false);
});
test('interleaved concurrent dispatches keep independent terminal usage', async () => {
  const streams = [new PassThrough(), new PassThrough()]; const events = [];
  const remotes = streams.map((body) => upstream({ body }));
  const responses = await Promise.all(remotes.map((remote) => pinnedFetch(selection(), remote.send, () => (event) => events.push(event))(
    new Request(endpoint, { method: 'POST', body: '{}' }))));
  const reads = responses.map((response) => response.text());
  streams[1].end(terminal({ input_tokens: 20, output_tokens: 4 })); streams[0].end(terminal()); await Promise.all(reads);
  for (const [index, response] of responses.entries()) {
    const rows = events.filter((event) => event.dispatch_id === response.headers.get('x-memocap-dispatch-id'));
    assert.equal(rows.length, 2); assert.equal(rows[1].terminal.usage.tokens.input, index ? 20 : 10);
  }
});
for (const [name, text] of [
  ['missing', 'data: {"type":"response.output_text.delta","delta":"private"}\n\n'],
  ['prefix', terminal().slice(0, -1)], ['duplicate', `${terminal()}${terminal()}`],
  ['conflict', `${terminal()}${terminal(undefined, 'response.incomplete')}`],
  ['malformed', `data: {broken}\n\n${terminal()}`],
  ['missing_required', terminal({ input_tokens: 10 })], ['negative', terminal({ input_tokens: -1, output_tokens: 2 })],
  ['invalid_detail', terminal({ input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: '0' } })],
  ['error', `data: {"type":"error","message":"private"}\n\n${terminal()}`],
  ['incomplete', terminal(undefined, 'response.incomplete')], ['failed', terminal(null, 'response.failed')],
]) test(`${name} terminal evidence cannot establish completed usage`, async () => {
  const current = await observed([Buffer.from(text)]); assert.equal(await current.response.text(), text);
  assert.ok(current.events[1].terminal); assert.notEqual(current.events[1].terminal.status, 'completed');
});
test('body cancellation after headers and a terminal prefix emits exactly one failed finish', async () => {
  const body = new PassThrough(); const events = []; const remote = upstream({ body });
  const response = await pinnedFetch(selection(), remote.send, () => (event) => events.push(event))(
    new Request(endpoint, { method: 'POST', body: '{}' }));
  const reader = response.body.getReader(); body.write(terminal()); await reader.read();
  assert.equal(events.length, 1); await reader.cancel();
  assert.equal(events.length, 2); assert.equal(events[1].outcome, 'failed');
  assert.equal(body.destroyed, true); assert.equal(remote.request().destroyed, true);
});
test('overflow after terminal bytes cannot become successful completion', async () => {
  const current = await observed([Buffer.from(terminal()), Buffer.alloc(262144)]);
  await assert.rejects(current.response.arrayBuffer(), { code: 'provider_response_body_limit' });
  assert.equal(current.events.length, 2); assert.equal(current.events[1].outcome, 'failed');
});
