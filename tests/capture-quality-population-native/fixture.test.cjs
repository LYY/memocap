const assert = require('node:assert/strict');
const test = require('node:test');
const { createFixture } = require('./fixture.cjs');
const { createCarrier } = require('./carrier.cjs');
const { createCustody } = require('./custody.cjs');

async function projectionHarness(id = 'read-route', gate) {
  const carrier = createCarrier(id, { root: '/synthetic/private', node: '/synthetic/node' });
  const custody = await createCustody({ sessionID: 'root', version: '1.19.3' }, carrier);
  const observed = []; const admitted = []; const translations = [];
  const toolEntered = Promise.withResolvers();
  const hooks = await createFixture({ client: { session: {} } }, { binding() {}, charge() {}, writeCarrier() {},
    factory: async () => ({ event: async (value) => { observed.push(value.event); } }) });
  const operations = carrier.operations(0);
  hooks.bind({ user: 'Original request.', operations }, { charge() {}, record() {},
    user: (value) => custody.user(value, { user: 'Original request.', turn: 0 }),
    prepare(token) { const value = carrier.prepare(token); translations.push(value); return value; },
    async tool(value) { toolEntered.resolve(); await gate?.promise; custody.tool(value); admitted.push('tool'); },
    async complete(value) { custody.complete(value); admitted.push('complete'); } });
  await hooks['chat.message']({ sessionID: 'root' }, { message: { id: 'user', role: 'user' },
    parts: [{ id: 'user-part', messageID: 'user', sessionID: 'root', type: 'text', text: 'Original request.' }] });
  const message = { id: 'assistant', sessionID: 'root', parentID: 'user', role: 'assistant' };
  const update = (info) => ({ event: { type: 'message.updated', properties: { info } } });
  const stop = { ...message, finish: 'stop', time: { completed: 3 } };
  const send = (value) => hooks.event(value);
  const before = (index, callID = `call-${index}`) => hooks['tool.execute.before']({ sessionID: 'root',
    tool: operations[index].tool, callID }, { args: operations[index].input });
  function terminal(index = 0) {
    const value = translations[index]; const file = value.input.filePath;
    const lines = value.text.split('\n');
    const state = { status: value.failure ? 'error' : 'completed', input: value.input, time: { start: 1, end: 2 },
      ...(value.nativeTool === 'read' ? { output: `<path>${file}</path>\n<type>file</type>\n<content>\n${lines.map((line, offset) => `${offset + 1}: ${line}`).join('\n')}\n\n(End of file - total ${lines.length} lines)\n</content>`,
        metadata: { truncated: false, display: { type: 'file', path: file, text: value.text,
          lineStart: 1, lineEnd: lines.length, totalLines: lines.length, truncated: false } } }
        : { output: value.text, metadata: { exit: 0, output: value.text, truncated: false } }) };
    return { event: { type: 'message.part.updated', properties: { part: { id: `part-${index}`, messageID: message.id,
      sessionID: 'root', type: 'tool', tool: value.nativeTool, callID: `call-${index}`, state } } } };
  }
  await send(update(message));
  return { hooks, carrier, custody, observed, admitted, operations, send, before, terminal, update, stop, toolEntered: toolEntered.promise };
}

test('public event projects only actual completion and forwards identical stop notifications in order', async () => {
  const current = await projectionHarness('unicode-preference');
  const early = current.update({ ...current.stop, time: {} });
  const complete = current.update(current.stop);
  await current.send(early);
  await Promise.all([current.send(complete), current.send(structuredClone(complete))]);
  assert.deepEqual(current.admitted, ['complete']);
  assert.deepEqual(current.observed.slice(1), [early.event, complete.event, complete.event]);
  assert.equal(current.custody.finished(), true);
});

test('public event joins inflight terminal copies before completion and idle in observation order', async () => {
  const gate = Promise.withResolvers();
  const current = await projectionHarness('read-route', gate);
  await current.before(0);
  const terminal = current.terminal();
  const running = structuredClone(terminal); running.event.properties.part.state.status = 'running';
  await current.send(running);
  const complete = current.update(current.stop);
  const idle = { event: { type: 'session.idle', properties: { sessionID: 'root' } } };
  const cancelled = { event: { type: 'session.error', properties: { sessionID: 'root', error: { name: 'MessageAbortedError' } } } };
  const first = current.send(terminal);
  await current.toolEntered;
  const pending = [first, current.send(structuredClone(terminal)), current.send(complete),
    current.send(structuredClone(complete)), current.send(idle), current.send(cancelled)];
  gate.resolve();
  await Promise.all(pending);
  await current.send(structuredClone(terminal));
  assert.deepEqual(current.admitted, ['tool', 'complete']);
  assert.deepEqual(current.observed.slice(1), [running.event, terminal.event, terminal.event, complete.event,
    complete.event, idle.event, cancelled.event, terminal.event]);
  assert.deepEqual(current.custody.rows().map((row) => row.logical), ['u1', 's1', 'a1']);
});

for (const field of ['id', 'messageID', 'sessionID', 'callID', 'status', 'error', 'output']) {
  test(`public event rejects a conflicting terminal ${field} without forwarding it`, async () => {
    const current = await projectionHarness(); await current.before(0);
    const terminal = current.terminal(); await current.send(terminal);
    const conflict = structuredClone(terminal); const part = conflict.event.properties.part;
    if (['status', 'error', 'output'].includes(field)) part.state[field] = field === 'status' ? 'error' : 'conflict';
    else part[field] = 'foreign';
    await assert.rejects(current.send(conflict));
    assert.equal(current.observed.length, 2);
    assert.deepEqual(current.admitted, ['tool']);
  });
}

for (const field of ['id', 'parentID', 'sessionID', 'role', 'finish', 'error', 'completed']) {
  test(`public event rejects a conflicting completion ${field}`, async () => {
    const current = await projectionHarness('unicode-preference'); await current.send(current.update(current.stop));
    const conflict = structuredClone(current.stop);
    if (field === 'completed') conflict.time.completed = 4;
    else conflict[field] = 'foreign';
    await assert.rejects(current.send(current.update(conflict)));
    assert.deepEqual(current.admitted, ['complete']);
    assert.equal(current.observed.length, 2);
  });
}

test('public event preserves invalid completed-time validation and does not forward invalid source bytes', async () => {
  const current = await projectionHarness(); await current.before(0);
  const terminal = current.terminal(); terminal.event.properties.part.state.output = 'invalid';
  await assert.rejects(current.send(terminal), /native_source_bytes_or_framing/);
  assert.equal(current.observed.length, 1);
  const completion = await projectionHarness('unicode-preference');
  await assert.rejects(completion.send(completion.update({ ...completion.stop, time: { completed: 0 } })), /native_completion_missing/);
  assert.equal(completion.observed.length, 1);
});

test('direct custody still rejects repeated completion independently of event projection', async () => {
  const current = await projectionHarness('unicode-preference');
  current.custody.complete(current.stop);
  assert.throws(() => current.custody.complete(current.stop), /native_completion_missing/);
});

test('subsequent prepare waits for an already observed terminal RPC without reordering operations', async () => {
  const gate = Promise.withResolvers(); const current = await projectionHarness('irrelevant-change', gate);
  await current.before(0);
  const first = current.send(current.terminal(0));
  await current.toolEntered;
  const next = current.before(1);
  gate.resolve();
  await Promise.all([first, next]);
  await current.send(current.terminal(1));
  await current.send(current.update(current.stop));
  assert.deepEqual(current.admitted, ['tool', 'tool', 'complete']);
  assert.equal(current.carrier.audit().observed, 2);
});

test('genuine parallel and out of order prepares still fail before source admission', async () => {
  const wrong = await projectionHarness('irrelevant-change');
  await assert.rejects(wrong.before(1), /source_order_or_identity/);
  const parallel = await projectionHarness('irrelevant-change');
  const result = await Promise.allSettled([parallel.before(0), parallel.before(1)]);
  assert.equal(result[0].status, 'fulfilled');
  assert.equal(result[1].status, 'rejected');
  assert.equal(result[1].reason.code, 'source_terminal_or_pending');
  assert.deepEqual(parallel.admitted, []);
});

test('invalid source rejects while a later lifecycle notification remains observable', async () => {
  const current = await projectionHarness(); await current.before(0);
  const invalid = current.terminal(); invalid.event.properties.part.state.output = 'invalid';
  const rejected = current.send(invalid);
  const cancelled = { event: { type: 'session.error', properties: { sessionID: 'root' } } };
  const lifecycle = current.send(cancelled);
  await assert.rejects(rejected, /native_source_bytes_or_framing/); await lifecycle;
  assert.deepEqual(current.observed.slice(1), [cancelled.event]);
});
