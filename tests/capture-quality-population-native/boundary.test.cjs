const assert = require('node:assert/strict');
const test = require('node:test');
const { createFixture } = require('./fixture.cjs');
const { observeNativeInvoke } = require('./native-boundary.cjs');
const { createLedger } = require('./ledger.cjs');
const { createMeter } = require('./inventory.cjs');
const { runCase } = require('./adapter.cjs');
const { fakeHost } = require('./fake-host.cjs');
const { offline, savedScenario } = require('./scenarios.cjs');
const { receipt, memory } = require('../plugin-fixture.cjs');

async function fixtureHarness() {
  const observed = [];
  let wrapped;
  const input = { client: { session: { create: async () => ({ data: { id: 'child' } }),
    delete: async () => ({ data: true }), messages: async () => ({ data: [] }),
    prompt: async () => ({ data: { info: {}, parts: [{ type: 'text', text: '{"candidates":[]}' }] } }) } } };
  const hooks = await createFixture(input, { writeCarrier: async () => {}, binding() {},
    factory: async (supplied) => { wrapped = supplied.client; return { tool: { memocap_remember: {
      execute: async (_args, context) => { await context.ask({ permission: 'memocap_remember' }); return JSON.stringify({ status: 'ok' }); },
    } } }; } });
  hooks.bind({ user: 'Inspect synthetic input.', operations: [] }, { reviewAllowed: () => true, user() {}, charge() {}, record: (event) => observed.push(event) });
  await hooks['chat.message']({ sessionID: 'parent' }, { message: { id: 'user' }, parts: [] });
  return { hooks, observed, wrapped };
}

test('standalone fixture delegates native ask and retains terminal denial without invoking tool output', async () => {
  const { hooks, observed } = await fixtureHarness();
  let asks = 0;
  await assert.rejects(hooks.tool.memocap_remember.execute({}, { sessionID: 'parent', messageID: 'msg',
    ask: async () => { asks++; throw new Error('denied'); } }), /denied/);
  assert.equal(asks, 1); assert.equal(observed[0].kind, 'permission');
  assert.equal(observed[0].outcome, 'denied'); assert.equal(observed.length, 1);
});

test('support-request input remains a model response and cannot fabricate admission or issuance', async () => {
  const { wrapped, observed } = await fixtureHarness();
  await wrapped.session.create({ body: { parentID: 'parent', title: 'memocap capture extract' } });
  await wrapped.session.prompt({ path: { id: 'child' }, body: { parts: [{ type: 'text', text: '{"candidate":{"statements":[]}}' }] } });
  assert.deepEqual(observed.map((event) => event.kind), ['model.response']);
  await assert.rejects(wrapped.session.messages({ path: { id: 'parent' } }), /parent_history_forbidden/);
});

test('unobserved child deletion remains charged and visible across original turns', async () => {
  const { hooks, wrapped } = await fixtureHarness();
  await wrapped.session.create({ body: { parentID: 'parent', title: 'memocap capture extract' } });
  hooks.bind({ user: 'Continue.', operations: [] }, { reviewAllowed: () => true, user() {}, charge() {}, record() {} });
  assert.deepEqual(hooks.state().children, ['child']);
});

test('native observer never calls the underlying writer twice when its response is lost', async () => {
  const events = []; let calls = 0;
  const invoke = observeNativeInvoke(async (_argv, options) => { calls++; options.beforeSpawn(); throw new Error('response lost'); },
    { binding: () => ({ root: 'root', user: 'user', session: 'child', message: 'message', tool: 'memocap_remember' }),
      record: (event) => events.push(event), database: () => '/synthetic/db', charge() {} });
  await assert.rejects(invoke(['remember'], { beforeSpawn() {} }), /response lost/);
  assert.equal(calls, 1); assert.deepEqual(events.map((event) => event.kind), ['consume', 'native.dispatch']);
});

test('native observer validates actual caller receipt and exposes independent readback to the ledger', async () => {
  const meter = createMeter(offline, 'offline'); const ledger = createLedger(meter); ledger.begin('root', 'user');
  const binding = { root: 'root', user: 'user', session: 'child', message: 'message', tool: 'memocap_remember' };
  ledger.record({ ...binding, kind: 'permission', outcome: 'resolved' });
  const written = receipt('remember', { status: 'inserted', caller: { actor: 'plugin', session_id: 'child', message_id: 'message' },
    results: [memory()], returned_ids: [1], searched_placements: [memory().memory.placement] });
  const read = receipt('read', { operation_id: '00000000-0000-0000-0000-000000000312', results: [memory()], returned_ids: [1], truncated: false });
  const invoke = observeNativeInvoke(async (argv, options) => {
    if (argv[0] === 'remember') options.beforeSpawn();
    return { receipt: argv[0] === 'remember' ? written : read };
  }, { binding: () => binding, record: ledger.record, charge: meter.charge, database: () => '/synthetic/db' });
  await invoke(['remember'], { beforeSpawn() {} }); await invoke(['read'], {});
  assert.equal(ledger.snapshot().saved_outputs[0].verified, true);
  assert.equal(ledger.snapshot().reviews[0].trace_status, 'blocked_missing_observation');
});

test('unknown first-turn write prevents later original turns from dispatching or replaying', async () => {
  let reviews = 0;
  const host = fakeHost({ settle(context) { reviews++; return savedScenario(context, { unknown: true }); } });
  const result = await runCase('same-task-third-turn', { host, budget: offline });
  assert.equal(result.reason, 'unknown_write_blocks_followup'); assert.equal(reviews, 1);
  assert.equal(result.cleanup.removed, false);
});

test('recovery-only and recalled-unused roots cannot dispatch a fresh mutation', async () => {
  for (const id of ['lost-response', 'recalled-unused']) {
    const host = fakeHost({ settle: (context) => savedScenario(context, { workflow: 'maintenance' }) });
    const result = await runCase(id, { host, budget: offline });
    assert.equal(result.reason, 'unscheduled_native_write'); assert.equal(result.trace.writes.length, 0);
  }
});

test('standalone fixture refuses a root write without an observed review before dispatch', async () => {
  const observed = []; let calls = 0;
  const written = receipt('remember', { status: 'inserted', caller: { actor: 'plugin', session_id: 'parent', message_id: 'msg' },
    results: [memory()], returned_ids: [1], searched_placements: [memory().memory.placement] });
  const hooks = await createFixture({ client: { session: {} } }, { writeCarrier: async () => {}, binding() {}, charge() {},
    database: () => '/synthetic/db', invoke: async (_argv, options) => { calls++; options.beforeSpawn(); return { receipt: written }; },
    factory: async (_input, options) => ({ tool: { memocap_remember: { async execute(_args, context) {
      await context.ask({ permission: 'memocap_remember' });
      const response = await options.invoke(['remember'], { beforeSpawn() {} });
      return JSON.stringify(response.receipt);
    } } } }) });
  hooks.bind({ user: 'Inspect synthetic input.', operations: [] }, { reviewAllowed: () => true, user() {}, charge() {}, record: (event) => observed.push(event) });
  await hooks['chat.message']({ sessionID: 'parent' }, { message: { id: 'user' }, parts: [] });
  await assert.rejects(hooks.tool.memocap_remember.execute({}, { sessionID: 'parent', messageID: 'msg', ask: async () => {} }), /write_workflow_unobserved/);
  assert.equal(calls, 0);
  assert.deepEqual(observed.map((event) => event.kind), ['permission']);
});

test('an unverified setup write retains its private recovery state', async () => {
  const host = fakeHost();
  const seed = host.seed;
  host.seed = async (snapshot) => { const value = await seed(snapshot); value.readback.content = 'different'; return value; };
  const result = await runCase('missing-file', { host, budget: offline });
  assert.equal(result.reason, 'seed_custody_missing');
  assert.equal(result.cleanup.removed, false);
  assert.equal(result.setup_recovery_required, true);
});

test('independent recovery read is retained when the original write receipt was lost', async () => {
  const meter = createMeter(offline, 'offline'); const ledger = createLedger(meter); ledger.begin('root', 'user');
  const binding = { root: 'root', user: 'user', session: 'child', message: 'message', tool: 'memocap_remember' };
  ledger.record({ ...binding, kind: 'permission', outcome: 'resolved' });
  const read = receipt('read', { operation_id: '00000000-0000-0000-0000-000000000313', results: [memory()], returned_ids: [1], truncated: false });
  const invoke = observeNativeInvoke(async (argv, options) => {
    if (argv[0] === 'remember') { options.beforeSpawn(); throw new Error('response lost'); }
    return { receipt: read };
  }, { binding: () => binding, record: ledger.record, charge: meter.charge, database: () => '/synthetic/db' });
  await assert.rejects(invoke(['remember'], { beforeSpawn() {} }), /response lost/);
  await invoke(['read'], {});
  assert.equal(ledger.snapshot().recovery_required, true);
  assert.equal(ledger.snapshot().events.at(-1).kind, 'recovery.readback');
  assert.equal(ledger.snapshot().saved_outputs.length, 0);
});
