const assert = require('node:assert/strict');
const test = require('node:test');
const { productionProbe } = require('./production-probe.cjs');
const { createFixture } = require('./fixture.cjs');
const { createCarrier } = require('./carrier.cjs');
const { observeNativeInvoke } = require('./native-boundary.cjs');
const { inventory } = require('./inventory.cjs');

test('REAL factory public organize page uses only charged injected invocation', async () => {
  const probe = await productionProbe();
  const calls = [];
  const hooks = await probe.factory({ directory: '/synthetic/project', client: { session: {} } }, {
    invoke: async (argv) => { calls.push(argv); throw Object.assign(new Error('probe_reached'), { code: 'probe_reached' }); } });
  try {
    const result = await hooks.tool.memocap_organize.execute({ operation: 'page', request: '{}' }, {
      sessionID: 'root', messageID: 'message', abort: new AbortController().signal, metadata() {}, ask: async () => {} });
    assert.equal(JSON.parse(result.output).error.code, 'probe_reached');
    assert.equal(calls.length, 1);
    assert.equal(probe.defaults.length, 0);
  } finally { await hooks.dispose(); }
});

test('generic organization apply is refused before underlying native dispatch', async () => {
  let calls = 0;
  const invoke = observeNativeInvoke(async () => { calls++; }, { binding: () => ({ root: 'root', user: 'user' }),
    record() {}, database: () => '/synthetic/db', charge() {} });
  await assert.rejects(invoke(['organize', 'apply'], {}), /quality_organization_apply_forbidden/);
  assert.equal(calls, 0);
});

async function harness() {
  let client;
  let serial = 0;
  let prepared = 0;
  let materialized = 0;
  let sources = 0;
  const hooks = await createFixture({ client: { session: {
    create: async () => ({ data: { id: `child-${++serial}` } }), delete: async () => ({ data: true }) } } }, {
    factory: async (input) => { client = input.client; return {}; }, binding() {}, charge() {},
    writeCarrier: async () => { materialized++; } });
  const carrier = createCarrier('queued-exit-zero', { root: '/synthetic/private', node: '/synthetic/node' });
  const operations = carrier.operations(0);
  hooks.bind({ user: 'Original synthetic request.', operations }, { reviewAllowed: () => true,
    user() {}, charge() {}, record() {}, tool() { sources++; }, prepare(token) { prepared++; return carrier.prepare(token); } });
  await hooks['chat.message']({ sessionID: 'root' }, { message: { id: 'user' }, parts: [] });
  return { hooks, client, operations, stats: () => ({ prepared, materialized }), sources: () => sources };
}

test('real bash description is nonsemantic while executable input matches exactly', async () => {
  const current = await harness();
  const operation = current.operations[0];
  await current.hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash', callID: 'call' },
    { args: { ...operation.input, description: 'Run the supplied verification operation' } });
  assert.deepEqual(current.stats(), { prepared: 1, materialized: 1 });
});

for (const extra of [{ command: 'arbitrary' }, { timeout: 1 }, { workdir: '/foreign' }, { description: '\nunsafe' }]) {
  test(`wrong execution field is refused before prepare: ${Object.keys(extra)[0]}`, async () => {
    const current = await harness();
    await assert.rejects(current.hooks['tool.execute.before']({ sessionID: 'root', tool: 'bash', callID: 'call' },
      { args: { ...current.operations[0].input, ...extra } }), /unmapped_native_source_request/);
    assert.deepEqual(current.stats(), { prepared: 0, materialized: 0 });
  });
}

test('maintenance three generations and capture three generations have independent budgets', async () => {
  const { hooks, client } = await harness();
  for (const workflow of ['maintenance', 'capture']) {
    const first = await client.session.create({ body: { parentID: 'root', title: `memocap ${workflow} ${workflow === 'capture' ? 'extract' : 'review'}` } });
    await hooks['chat.params']({ sessionID: first.data.id }, {});
    await hooks['chat.params']({ sessionID: first.data.id }, {});
    const commit = await client.session.create({ body: { parentID: 'root', title: `memocap ${workflow} commit` } });
    await hooks['chat.params']({ sessionID: commit.data.id }, {});
    await assert.rejects(hooks['chat.params']({ sessionID: commit.data.id }, {}), /review_generation_budget/);
    await assert.rejects(client.session.create({ body: { parentID: 'root', title: `memocap ${workflow} commit` } }), /child_binding_or_budget/);
  }
  assert.equal(hooks.state().children.length, 4);
});

test('finite inventory includes capture reviews on maintenance roots and both write ceilings', () => {
  const result = inventory();
  assert.equal(result.limits.capture_reviews, 31);
  assert.equal(result.limits.maintenance_reviews, 10);
  assert.equal(result.limits.reviews, 41);
  assert.equal(result.limits.worker_requests, 123);
  assert.equal(result.limits.children, 82);
  assert.equal(result.limits.review_write_attempts, 41);
});

test('actual tool completion with a different call ID is refused before source admission', async () => {
  const current = await harness(); const operation = current.operations[0];
  await current.hooks.event({ event: { type: 'message.updated', properties: { info: {
    id: 'assistant', role: 'assistant', sessionID: 'root', parentID: 'user' } } } });
  await current.hooks['tool.execute.before']({ sessionID: 'root', tool: operation.tool, callID: 'actual-call' }, { args: operation.input });
  await assert.rejects(current.hooks.event({ event: { type: 'message.part.updated', properties: { part: {
    id: 'part', messageID: 'assistant', sessionID: 'root', callID: 'different-call', tool: operation.tool,
    state: { status: 'completed', input: operation.input, output: 'queued' } } } } }), /native_call_custody/);
  assert.equal(current.sources(), 0);
});
