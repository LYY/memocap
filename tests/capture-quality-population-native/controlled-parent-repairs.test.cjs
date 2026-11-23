const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const filename = path.join(__dirname, 'controlled-parent.test.cjs');
const local = createRequire(filename);
const inert = (name) => name === 'node:test' ? () => {} : local(name);
const { harness, frames, callOf, terminal } = vm.compileFunction(
  `${fs.readFileSync(filename, 'utf8')}\nreturn { harness, frames, callOf, terminal };`,
  ['require', '__dirname'], { filename, importModuleDynamically: (specifier) => import(specifier) })(inert, __dirname);
const { createCarrier } = require('./carrier.cjs');
const { createCustody } = require('./custody.cjs');

async function sourceHarness(id, additional = []) {
  const carrier = createCarrier(id, { root: '/synthetic/private', node: '/synthetic/node' });
  const custody = await createCustody({ sessionID: 'root', version: '1.19.5' }, carrier);
  const current = await harness({ operations: [...carrier.operations(0), ...additional] });
  custody.user({ message: { id: 'user', role: 'user', sessionID: 'root' }, parts: [{ id: 'user-part',
    messageID: 'user', sessionID: 'root', type: 'text', text: current.bound.user }] }, { user: current.bound.user, turn: 0 });
  current.channel.bind({ charge(key, amount = 1) { current.used[key] = (current.used[key] ?? 0) + amount; },
    user() {}, record() {}, prepare: (token) => carrier.prepare(token), tool: custody.tool, complete: custody.complete }, async () => {});
  return { ...current, carrier, custody };
}
async function sourceTerminal(current, call) {
  const message = { id: `msg-${call.call_id}`, role: 'assistant', sessionID: 'root', parentID: 'user' };
  const input = JSON.parse(call.arguments);
  await current.hooks.event({ event: { type: 'message.updated', properties: { info: message } } });
  let beforeError;
  try { await current.hooks['tool.execute.before']({ sessionID: 'root', tool: call.name, callID: call.call_id }, { args: input }); }
  catch (error) { beforeError = error; }
  const value = current.carrier.pending();
  assert.ok(value, beforeError?.message);
  if (value.failure) assert.equal(beforeError?.message, value.text);
  else assert.equal(beforeError, undefined);
  const lines = value.text.split('\n');
  const output = value.failure || call.name === 'bash' ? value.text :
    `<path>${input.filePath}</path>\n<type>file</type>\n<content>\n${lines.map((line, index) => `${index + 1}: ${line}`).join('\n')}\n\n(End of file - total ${lines.length} lines)\n</content>`;
  const state = { status: value.failure ? 'error' : 'completed', input, time: { start: 1, end: 2 },
    ...(value.failure ? { error: output } : { output, metadata: call.name === 'bash' ?
      { exit: 0, output, truncated: false } : { truncated: false, display: { type: 'file', path: input.filePath,
        text: value.text, lineStart: 1, lineEnd: lines.length, totalLines: lines.length, truncated: false } } }) };
  await current.hooks.event({ event: { type: 'message.part.updated', properties: { part: {
    id: `part-${call.call_id}`, type: 'tool', sessionID: 'root', messageID: message.id, callID: call.call_id, tool: call.name, state } } } });
  return [{ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
    { type: 'function_call_output', call_id: call.call_id, output }];
}

test('F1 emitted failed-fixed bash joins actual before and terminal custody', async () => {
  const current = await sourceHarness('failed-fixed');
  try {
    await current.params(); const call = callOf(await frames(await current.send()));
    assert.equal(call.name, 'bash');
    const history = await sourceTerminal(current, call);
    assert.equal(current.carrier.audit().observed, 1);
    assert.equal(current.custody.rows()[1].actual.call, call.call_id);
    assert.equal(typeof history[1].output, 'string');
  } finally { await current.close(); }
});
test('F2 ordinary read error advances to the next declared source call with error history retained', async () => {
  const operations = ['a', 'b'].map((token) => ({ token, tool: 'read', input: { filePath: `/synthetic/${token}` } }));
  const current = await harness({ operations });
  current.channel.bind({ charge() {}, user() {}, record() {}, complete() {}, prepare: (token) => ({ token }), tool() {} }, async () => {});
  try {
    await current.params(); const call = callOf(await frames(await current.send()));
    const history = await terminal(current, call, 'inert_source_failure', 'error');
    await current.params(); const next = callOf(await frames(await current.send(history)));
    assert.equal(next.type, 'function_call'); assert.deepEqual(JSON.parse(next.arguments), operations[1].input);
    assert.equal(history[1].output, 'inert_source_failure');
  } finally { await current.close(); }
});
test('F2 original failed-fixed executes repair verifier and route after its observed failure', async () => {
  const current = await sourceHarness('failed-fixed');
  try {
    const history = [];
    for (const operation of current.bound.operations) {
      await current.params(); const call = callOf(await frames(await current.send(history)));
      assert.equal(call.type, 'function_call'); assert.equal(call.name, operation.tool);
      history.push(...await sourceTerminal(current, call));
    }
    await current.params(); assert.equal(callOf(await frames(await current.send(history))).type, 'message');
    await current.hooks.event({ event: { type: 'message.updated', properties: { info: {
      id: 'done', sessionID: 'root', parentID: 'user', role: 'assistant', finish: 'stop', time: { completed: 3 } } } } });
    assert.equal(current.carrier.audit().observed, 4); assert.equal(current.custody.finished(), true);
    assert.ok(history[1].output); assert.equal(current.remote.calls.length, 0);
  } finally { await current.close(); }
});
test('source permission denial never retries or advances to a new source operation', async () => {
  const current = await sourceHarness('denied-source', [{ token: 'forbidden-followup', tool: 'read', input: { filePath: '/synthetic/forbidden' } }]);
  try {
    await current.params(); const call = callOf(await frames(await current.send()));
    const history = await sourceTerminal(current, call);
    assert.equal(current.carrier.audit().terminal, true);
    await current.params(); assert.equal(callOf(await frames(await current.send(history))).type, 'message');
    await assert.rejects(current.params(), /controlled_finished/);
    assert.equal(current.carrier.audit().observed, 1); assert.equal(current.remote.calls.length, 0);
  } finally { await current.close(); }
});
for (const action of ['params', 'send', 'create', 'reserved-send']) test(`F3 cancelled root blocks child ${action} before effects`, async () => {
  const current = await harness();
  try {
    const child = (await current.client.session.create({ body: { parentID: 'root', title: 'memocap capture extract' } })).data.id;
    if (action === 'reserved-send') await current.params(child);
    await current.params(); const response = await current.send(); await response.body.cancel();
    const before = structuredClone(current.used);
    const invoke = action === 'params' ? () => current.params(child) : action === 'create' ?
      () => current.client.session.create({ body: { parentID: 'root', title: 'memocap capture commit' } }) : () => current.send([], child);
    await assert.rejects(invoke(), /controlled_cancelled/);
    assert.deepEqual(current.used, before); assert.equal(current.remote.calls.length, 0);
    assert.equal((await current.client.session.delete({ path: { id: child } })).data, true);
  } finally { await current.close(); }
});
test('normally finished root permits child creation generation and forwarding', async () => {
  const current = await harness();
  try {
    await current.params(); await frames(await current.send());
    const child = (await current.client.session.create({ body: { parentID: 'root', title: 'memocap capture extract' } })).data.id;
    await current.params(child); assert.equal(await (await current.send([], child)).text(), 'data: ok\n\n');
    assert.equal(current.remote.calls.length, 1);
  } finally { await current.close(); }
});
