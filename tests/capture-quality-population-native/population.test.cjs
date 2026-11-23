const assert = require('node:assert/strict');
const test = require('node:test');
const { mapping, resolveCase } = require('../capture-quality-population/inputs.cjs');
const { runCase } = require('./adapter.cjs');
const { fakeHost } = require('./fake-host.cjs');
const { sourceMutations, adversaries, offline, savedScenario } = require('./scenarios.cjs');
const { inventory, createMeter } = require('./inventory.cjs');
const { population, tuningPopulation } = require('./population.cjs');

for (const { id } of mapping.cases) test(`delivers ${id} through supported tool framing with exact original custody`, async () => {
  const host = fakeHost();
  if (id === 'synthetic-secret') host.open = () => assert.fail('screened unit opened host');
  const original = resolveCase(id).original;
  const result = await runCase(id, { host, budget: offline });
  assert.equal(result.status, 'wired', result.reason);
  assert.equal(result.quality_credit, false);
  if (id === 'synthetic-secret') {
    assert.deepEqual(result.turns.map((turn) => turn.status), original.turns.map(() => 'screened_whole_unit'));
    assert.equal(result.transport, null); assert.equal(result.trace, null); assert.equal(result.cleanup, null);
    assert.deepEqual(result.custody, []); assert.deepEqual(result.completion_evidence, []);
    assert.deepEqual(result.budget_used, {});
    assert.deepEqual(host.packets, []); assert.deepEqual(host.translations, []); assert.deepEqual(host.memory, []);
    assert.deepEqual(host.stats, { open: 0, closed: 0, children: 0, native_processes: 0, provider_requests: 0, writes: 0 });
    return;
  }
  assert.equal(result.transport.observed, result.transport.planned);
  if (original.turns) {
    assert.deepEqual(host.packets.map((packet) => packet.user), original.turns.map((turn) => turn.user));
    const logicalTools = original.turns.flatMap((turn) => turn.tools.map((tool) => tool.id));
    assert.deepEqual(result.custody.filter((row) => row.origin === 'original-tool').map((row) => row.logical), logicalTools);
    for (const row of result.custody.filter((row) => row.origin === 'original-tool')) assert.notEqual(row.logical, row.actual.part);
  } else {
    assert.deepEqual(result.seeds.map((seed) => seed.content), [original.record, ...(original.participants ?? [])].map((record) => record.body));
    assert.equal(result.trace.events.filter((event) => event.kind === 'memory.use').length, original.used ? 1 : 0);
    assert.equal(host.packets[0].adapter_added, true);
  }
  assert.deepEqual(result.cleanup, { exited: true, children: 0, removed: true });
});

for (const [name, mutateSource] of sourceMutations) test(`refuses ${name} before any native commit`, async () => {
  const result = await runCase('read-route', { host: fakeHost({ mutateSource }), budget: offline });
  assert.equal(result.status, 'blocked'); assert.equal(result.trace.writes.length, 0);
});

test('public adversarial scenarios retain unknown writes and reject forged/readback/denied stages', async () => {
  const result = await adversaries();
  assert.equal(result.length, 23);
});

test('every earlier-turn saved output remains in the ledger', async () => {
  const host = fakeHost({ settle: (context) => savedScenario(context) });
  const result = await runCase('same-task-third-turn', { host, budget: offline });
  assert.equal(result.status, 'wired', result.reason);
  assert.equal(result.trace.saved_outputs.length, 3);
  assert.equal(new Set(result.trace.saved_outputs.map((row) => row.user)).size, 3);
});

test('secret-shaped original unit never reaches a review or synthetic generation', async () => {
  const host = fakeHost({ settle() { assert.fail('secret unit reached model review'); } });
  host.open = () => assert.fail('screened unit opened host');
  const result = await runCase('synthetic-secret', { host, budget: offline });
  assert.equal(result.status, 'wired', result.reason);
  assert.equal(result.turns[0].status, 'screened_whole_unit');
  assert.equal(result.transport, null); assert.equal(result.trace, null); assert.equal(result.cleanup, null);
  assert.deepEqual(result.custody, []); assert.deepEqual(result.completion_evidence, []);
  assert.deepEqual(result.budget_used, {});
  assert.deepEqual(host.packets, []); assert.deepEqual(host.translations, []); assert.deepEqual(host.memory, []);
  assert.deepEqual(host.stats, { open: 0, closed: 0, children: 0, native_processes: 0, provider_requests: 0, writes: 0 });
  assert.equal(result.quality_credit, false);
});

test('bounded host waits preserve recovery ownership on unknown startup', async () => {
  const host = fakeHost();
  host.open = () => new Promise(() => {});
  const result = await runCase('read-route', { host, budget: offline, timeout_ms: 2 });
  assert.equal(result.reason, 'host_boundary_timeout'); assert.equal(result.cleanup.removed, false);
});

test('finite inventory rejects the consumed one-route allowance', () => {
  const report = inventory();
  assert.equal(report.limits.turns, 32); assert.equal(report.limits.operations, 42);
  assert.equal(report.limits.seeds, 14); assert.equal(report.limits.setup_writes, 15);
  assert.equal(report.limits.requests, 222); assert.equal(report.limits.children, 82);
  assert.equal(report.old_canary_budget_reusable, false);
  assert.throws(() => createMeter({ mode: 'native', approved: true, limits: { requests: 28, setup_writes: 3 } }, 'native'), /separate_approved_budget_required/);
});

test('meter refuses overflow before a second bounded source action', () => {
  const meter = createMeter(offline, 'offline');
  meter.charge('operations', 42);
  assert.throws(() => meter.charge('operations'), /budget_operations/);
});

test('a claimed frozen catalog cannot bypass explicit descriptor binding', () => {
  const future = { ...tuningPopulation, mapping: { ...mapping, tuning_sha256: 'a'.repeat(64) }, frozen: true };
  assert.throws(() => population(future), /explicit_frozen_population_required/);
  assert.throws(() => population({ ...future, frozen: false }), /explicit_frozen_population_required/);
});

async function terminalCollectionHarness(emitTerminal = true) {
  const { install } = require('./plugin-runtime.cjs');
  let boundary; let seam; let packet; let cutoff = false;
  const commands = []; const replies = [];
  const waiting = Promise.withResolvers();
  const hooks = await install({ client: { session: {} }, serverUrl: new URL('http://inert.invalid') }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: require('./authorization.cjs').sources().digest,
    approval_id: 'injected-only', socket: '/synthetic/socket', token: 'injected-only', privateRoot: '/synthetic',
    paths: { database: '/synthetic/memory.db' }, endpoints: [], case: 'same-task-third-turn',
  }, {
    fetch: async () => assert.fail('network_forbidden'),
    native: { invoke: async () => assert.fail('native_forbidden') },
    fixture: async (_, injected) => {
      seam = injected;
      return { bind(value) { packet = value; }, state: () => ({ children: [] }), dispose() {} };
    },
    rpc: async (route, value) => {
      switch (route) {
        case '/next': {
          const command = commands.shift() ?? { method: 'stop' };
          if (command.method === 'wait') waiting.resolve();
          return command;
        }
        case '/result':
          if (value.id === 'wait-1' && !value.error) await new Promise((resolve) => setTimeout(resolve, 2999));
          replies.push(value); return {};
        case '/observations':
          for (const event of value.events) boundary.record(event);
          return {};
        default: return {};
      }
    },
  });
  const host = fakeHost(); const deliver = host.deliver;
  host.deliver = async (value, target) => {
    boundary = target;
    commands.push({ id: 'bind', method: 'bind', value: { ...value, root: 'root', review: true } });
    await hooks.qualityPump();
    await deliver(value, target);
  };
  host.settle = async (request) => {
    const root = host.packets.length;
    if (root === 1) setTimeout(() => {
      cutoff = true;
      if (emitTerminal) setTimeout(() => seam.review({ parentID: packet.root, user_id: request.user,
        workflow: 'capture', status: 'failed', reason: 'capture_timeout', model_calls: 3,
        tool_calls: 0, write_attempts: 0 }), 317.439);
    }, 30000);
    else seam.review({ parentID: packet.root, user_id: request.user, workflow: 'capture', status: 'no_candidate' });
    commands.push({ id: `wait-${root}`, method: 'wait', value: request });
    await hooks.qualityPump();
    const reply = replies.at(-1);
    require('./value.cjs').requireStage(!reply.error, reply.error);
    return reply.value;
  };
  return { host, waiting: waiting.promise, cutoff: () => cutoff, dispose: () => hooks.dispose() };
}

test('collects capture timeout after execution cutoff and attempts the next root turn', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const current = await terminalCollectionHarness();
  const running = runCase('same-task-third-turn', { host: current.host, budget: offline });
  await current.waiting; await new Promise(setImmediate);
  context.mock.timers.tick(30000);
  await new Promise(setImmediate);
  context.mock.timers.tick(318);
  await new Promise(setImmediate);
  context.mock.timers.tick(2999);
  const result = await running;
  await current.dispose();
  assert.equal(result.status, 'wired', result.reason);
  assert.equal(current.cutoff(), true);
  assert.equal(result.turns[0].result.reviews[0].status, 'failed');
  assert.equal(result.turns[0].result.reviews[0].reason, 'capture_timeout');
  assert.equal(result.turns.length, 3);
  assert.equal(result.trace.writes.length, 0);
  assert.equal(result.budget_used.worker_requests ?? 0, 0);
  context.diagnostic(JSON.stringify({ public_driver: 'runCase/install', cutoff_ms: 30000,
    terminal_ms: 30317.439, result_forwarding_ms: 2999, status: result.status, review: result.turns[0].result.reviews[0],
    attempted_root_turns: result.turns.length, native_writes: result.trace.writes.length }));
});

test('missing capture terminal remains bounded with its review deadline diagnostic', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const current = await terminalCollectionHarness(false);
  const running = runCase('same-task-third-turn', { host: current.host, budget: offline });
  await current.waiting; await new Promise(setImmediate);
  context.mock.timers.tick(33000);
  await new Promise(setImmediate);
  const result = await running;
  await current.dispose();
  assert.equal(result.reason, 'review_deadline');
  assert.equal(result.turns.length, 0);
  assert.equal(current.host.packets.length, 1);
  assert.equal(result.cleanup.exited, true);
});
