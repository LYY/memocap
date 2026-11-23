const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
const { toy } = require('./evaluation-fixture.cjs');
const { createEvaluation, population } = require('./population.cjs');
const { inventory, createMeter, caseLimits, runLimits } = require('./inventory.cjs');
const { hash } = require('./value.cjs');
const retained = require('./retained-counters.fixture.json');
const profile = 'controlled_native_parent_genuine_curator_v1';
function grantFor(evaluation, prior) {
  const needed = inventory(evaluation);
  return { mode: 'native', approved: true, approval_id: 'in-memory-budget-test', limits: runLimits(evaluation, profile),
    inventory_sha256: hash(needed), population_sha256: needed.tuning_sha256,
    evaluation_sha256: needed.evaluation_sha256, retained_ledger_sha256: hash(prior) };
}
function harness(evaluation, prior = {}, caseRunner) {
  const filename = path.join(__dirname, 'runtime.cjs'); const local = createRequire(filename);
  const module = { exports: {} }; const effects = []; const cases = [];
  const approval = grantFor(evaluation, prior);
  const deps = { 'node:fs': { writeFileSync() { effects.push('marker'); }, mkdirSync() { effects.push('mkdir'); },
    readdirSync: () => [], rmdirSync() {} },
    './authorization.cjs': { authorize: () => approval, sources: () => ({ digest: 'inert' }) },
    './inventory.cjs': { inventory, createMeter },
    './concrete-host.cjs': { concreteHost(settings, _grant, id) {
      assert.deepEqual(settings.evaluation, evaluation); effects.push(id);
      return { mode: 'native', open() { effects.push('open'); throw new Error('in-memory-stop'); },
        close() { effects.push('close'); return { exited: true, children: 0, removed: false }; } }; } },
    './adapter.cjs': { runCase: caseRunner ?? (async (id, options) => {
      assert.equal(options.population.mapping.tuning_sha256, evaluation.input_sha256); cases.push(id); options.meter.charge('host_opens');
      return { id, cleanup: { exited: true, children: 0, removed: true, control_stopped: true, listener_closed: true } };
    }) } };
  const fake = (name) => deps[name] ?? local(name); fake.main = null;
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(fake, module, module.exports);
  return { effects, cases, run: () => module.exports[profile]({ evaluation,
    paths: { attempt: '/inert/attempt', privateRoot: '/inert/root' } }, approval, prior), approval };
}
const service = { requests: 147, parent_requests: 95, worker_requests: 52, provider_requests: 147,
  provider_request_bytes: 2017330, provider_response_bytes: 7186598 };
test('runtime schedules exactly the explicit selection and preserves actual worker charge', async () => {
  const evaluation = createEvaluation(toy()); const runner = harness(evaluation, service);
  const result = await runner.run();
  assert.deepEqual(runner.cases, ['toy-read', 'toy-update']);
  assert.deepEqual(result.planned_case_ids, runner.cases);
  assert.equal(result.budget_cumulative_used.worker_requests, 52);
  assert.equal(result.historical_worker_measurement.direct, 52);
  assert.equal(result.parent_origin, 'controlled_task_driving_and_declared_adoption');
  assert.equal(result.curator_origin, 'genuine_production_generations');
});
test('synthetic retained local counters remain intact when selected fresh hosts fit', async () => {
  assert.equal(Object.keys(retained).length, 29);
  const runner = harness(createEvaluation(toy()), retained);
  const result = await runner.run();
  assert.deepEqual(result.budget_prior_used, retained);
  assert.equal(result.budget_used.host_opens, 2); assert.equal(result.budget_cumulative_used.host_opens, 76);
});
for (const [dimension, amount] of [['requests', 222], ['worker_requests', 123]]) {
  test(`explicit cumulative ${dimension} exhaustion refuses before any attempt effects`, async () => {
    const prior = { ...service, [dimension]: amount };
    if (dimension === 'requests') { prior.parent_requests = 99; prior.worker_requests = 123; prior.provider_requests = 222; }
    if (dimension === 'worker_requests') { prior.parent_requests = 90; prior.requests = 213; prior.provider_requests = 213; }
    const runner = harness(createEvaluation(toy()), prior);
    runner.approval.cumulative_limits = { [dimension]: amount };
    await assert.rejects(runner.run(), new RegExp(`budget_${dimension}`));
    assert.deepEqual(runner.effects, []);
  });
}
test('public selected meter allows retained74 plus fresh1 host and refuses a second fresh host', () => {
  const input = toy(); const raw = JSON.parse(input.input_utf8); raw.maintenance = []; input.mapping.cases.pop();
  input.input_utf8 = JSON.stringify(raw); input.input_sha256 = hash(raw); input.mapping.tuning_sha256 = input.input_sha256;
  input.mapping_sha256 = hash(input.mapping); const evaluation = createEvaluation(input);
  const meter = createMeter(grantFor(evaluation, retained), 'native', evaluation,
    { retained_ledger: retained, execution_profile: profile });
  meter.charge('host_opens');
  assert.equal(meter.snapshot().host_opens, 1);
  assert.equal(meter.cumulativeSnapshot().host_opens, 75);
  for (const [key, amount] of Object.entries(retained)) assert.equal(meter.cumulativeSnapshot()[key], amount + (key === 'host_opens' ? 1 : 0));
  assert.throws(() => meter.charge('host_opens'), /budget_host_opens/);
});
test('worst-case fresh worker reservation refuses before marker even with one slot left', async () => {
  const prior = { ...service, parent_requests: 89, requests: 211, provider_requests: 211, worker_requests: 122 };
  const runner = harness(createEvaluation(toy()), prior);
  runner.approval.cumulative_limits = { worker_requests: 123 };
  await assert.rejects(runner.run(), /budget_worker_requests/); assert.deepEqual(runner.effects, []);
});
for (const dimension of ['provider_request_bytes', 'provider_response_bytes']) {
  test(`worst-case fresh ${dimension} refuses before marker when reservation exceeds remaining bytes`, async () => {
    const evaluation = createEvaluation(toy()); const limits = inventory().limits;
    const fresh = inventory(evaluation).limits.worker_requests * 262144;
    const runner = harness(evaluation, { ...retained, [dimension]: limits[dimension] - fresh + 1 });
    runner.approval.cumulative_limits = { [dimension]: limits[dimension] };
    await assert.rejects(runner.run(), new RegExp(`budget_${dimension}`)); assert.deepEqual(runner.effects, []);
  });
}
test('controlled local roots use selected parent slots without spending genuine parent headroom', () => {
  const evaluation = createEvaluation(toy()); const accounting = { retained_ledger: retained, execution_profile: profile };
  const meter = createMeter(grantFor(evaluation, retained), 'native', evaluation, accounting);
  const slots = inventory(evaluation).limits.parent_requests;
  meter.charge('scripted_root_generations', slots);
  assert.equal(meter.cumulativeSnapshot().scripted_root_generations, 74 + slots);
  assert.equal(meter.cumulativeSnapshot().parent_requests, 95);
  assert.throws(() => meter.charge('parent_requests'), /budget_parent_requests/);
  assert.throws(() => meter.charge('scripted_root_generations'), /budget_scripted_root_generations/);
});
for (const dimension of ['requests', 'provider_requests', 'parent_requests', 'worker_requests', 'provider_request_bytes', 'provider_response_bytes']) {
  test(`selected grant cannot raise fresh genuine ${dimension}`, () => {
    const evaluation = createEvaluation(toy()); const grant = grantFor(evaluation, retained);
    grant.limits = { ...grant.limits, [dimension]: grant.limits[dimension] + 1 };
    assert.throws(() => createMeter(grant, 'native', evaluation,
      { retained_ledger: retained, execution_profile: profile }), /finite_evaluation_budget/);
  });
}
test('runtime refuses a retained hash mismatch before attempt marker and host', async () => {
  const prior = { ...retained }; const runner = harness(createEvaluation(toy()), prior); prior.host_opens++;
  await assert.rejects(runner.run(), /retained_ledger_grant_binding/); assert.deepEqual(runner.effects, []);
});
test('adapter revalidates the actual selected meter with identical retained context before host open', async () => {
  const evaluation = createEvaluation(toy()); const budget = grantFor(evaluation, retained);
  const accounting = { retained_ledger: retained, execution_profile: profile };
  const meter = createMeter(budget, 'native', evaluation, accounting); let opens = 0; let closes = 0;
  const host = { mode: 'native', open() { opens++; throw new Error('in-memory-stop'); },
    close() { closes++; return { exited: true, children: 0, removed: false }; } };
  const result = await require('./adapter.cjs').runCase('toy-read', { population: evaluation, budget, accounting, meter, host });
  assert.equal(result.reason, 'host_boundary_failed'); assert.equal(opens, 1); assert.equal(closes, 1);
  assert.equal(meter.snapshot().host_opens, 1); assert.equal(meter.cumulativeSnapshot().host_opens, 75);
});
test('adapter refuses foreign accounting profile on shared meter before any host effect', async () => {
  const evaluation = createEvaluation(toy()); const prior = { ...service, parent_requests: 90, requests: 142, provider_requests: 142 };
  const budget = grantFor(evaluation, prior); const accounting = { retained_ledger: prior, execution_profile: profile };
  const meter = createMeter(budget, 'native', evaluation, accounting);
  const result = await require('./adapter.cjs').runCase('toy-read', { population: evaluation, budget, meter,
    accounting: { retained_ledger: prior, execution_profile: null }, host: { mode: 'native', open() { assert.fail('opened'); } } });
  assert.equal(result.reason, 'finite_evaluation_budget'); assert.equal(result.cleanup, null);
});
test('runtime and actual adapter share fresh and retained accounting through in-memory host cleanup', async () => {
  const runner = harness(createEvaluation(toy()), retained, require('./adapter.cjs').runCase);
  const result = await runner.run();
  assert.deepEqual(runner.effects, ['marker', 'mkdir', 'toy-read', 'open', 'close']);
  assert.equal(result.cases[0].reason, 'host_boundary_failed'); assert.equal(result.stop_reason, 'unknown_cleanup');
  assert.deepEqual(result.budget_prior_used, retained);
  assert.equal(result.budget_used.host_opens, 1); assert.equal(result.budget_cumulative_used.host_opens, 75);
  assert.equal(result.budget_used.host_closes, 1); assert.equal(result.budget_cumulative_used.host_closes, 75);
  assert.equal(result.quality_credit, false);
});
for (const prior of [null, [], { ...retained, host_opens: -1 }, { ...retained, foreign_local: 1 }]) {
  test('public selected meter rejects malformed or foreign prior without host effects', () => {
    const evaluation = createEvaluation(toy());
    assert.throws(() => createMeter(grantFor(evaluation, prior), 'native', evaluation,
      { retained_ledger: prior, execution_profile: profile }), /invalid_prior_spend/);
  });
}
test('adapter refuses changed retained object before any host effect', async () => {
  const evaluation = createEvaluation(toy()); const budget = grantFor(evaluation, retained);
  const accounting = { retained_ledger: retained, execution_profile: profile };
  const meter = createMeter(budget, 'native', evaluation, accounting);
  const result = await require('./adapter.cjs').runCase('toy-read', { population: evaluation, budget, meter,
    accounting: { ...accounting, retained_ledger: { ...retained, host_opens: 73 } },
    host: { mode: 'native', open() { assert.fail('opened'); } } });
  assert.equal(result.reason, 'retained_ledger_grant_binding'); assert.equal(result.cleanup, null);
});
test('proposed eight-case reservation is computed from existing bounded case inventory without execution', () => {
  const ids = ['config-route', 'verified-api-route', 'runbook-short-route', 'same-task-third-turn', 'dropped-condition',
    'verified-condition-update', 'merge-unique-conditions', 'verified-retirement'];
  const totals = ids.map((id) => caseLimits(id)).reduce((sum, row) => {
    for (const [key, amount] of Object.entries(row)) if (typeof amount === 'number') sum[key] = (sum[key] ?? 0) + amount;
    return sum;
  }, {});
  for (const [key, amount] of Object.entries({ host_opens: 8, turns: 10, reviews: 13, children: 26, worker_requests: 39,
    parent_requests: 34, setup_writes: 5, native_reads: 122, sdk_requests: 1834, native_calls: 352,
    native_processes: 712, deadline_ms: 1182000 })) assert.equal(totals[key], amount, key);
  assert.equal(retained.requests + totals.worker_requests + 30, 216);
  assert.equal(retained.worker_requests + totals.worker_requests + 30, 121);
  assert.ok(216 <= inventory().limits.requests && 121 <= inventory().limits.worker_requests);
});
for (const prior of [{ ...service, worker_requests: 0 }, { ...service, requests: 148 },
  { ...service, worker_requests: -1 }, { ...service, unexpected_counter: 1 }]) {
  test('invalid retained ledger refuses before effects', async () => {
    const runner = harness(createEvaluation(toy()), prior);
    await assert.rejects(runner.run(), /invalid_prior_spend/); assert.deepEqual(runner.effects, []);
  });
}
test('controlled profile requires explicitly provided retained ledger', async () => {
  const runner = harness(createEvaluation(toy()));
  await assert.rejects(runner.run(), /controlled_prior_spend/); assert.deepEqual(runner.effects, []);
});
test('runtime accepts history beyond the former ceiling without an invented cumulative guard', async () => {
  const prior = { ...service, requests: 400, provider_requests: 400, worker_requests: 305 };
  const runner = harness(createEvaluation(toy()), prior);
  const result = await runner.run();
  assert.equal(result.population_status, 'complete');
  assert.deepEqual(result.budget_prior_used, prior);
  assert.equal(result.budget_cumulative_used.requests, 400);
  assert.equal(result.budget_used.host_opens, 2);
  assert.equal(Object.hasOwn(runner.approval, 'cumulative_limits'), false);
});
test('mismatched selected grant refuses before other runtime input access', () => {
  const { authorize } = require('./authorization.cjs'); const evaluation = createEvaluation(toy());
  const input = { evaluation, get network_binding() { return assert.fail('read network binding before selection rejection'); } };
  assert.throws(() => authorize(input, { kind: 'quality-full-population-native-v1', approved: true,
    authorization: 'approved-work', mode: 'native', approval_id: 'toy-approval-0123456789', evaluation_sha256: 'wrong' }),
  /evaluation_grant_binding/);
});
test('plugin rejects foreign selected case before native factory or configuration', async () => {
  const { install } = require('./plugin-runtime.cjs');
  const evaluation = createEvaluation(toy()); let effects = 0;
  await assert.rejects(install({ serverUrl: new URL('http://inert.invalid') }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: require('./authorization.cjs').sources().digest,
    approval_id: 'toy', socket: '/toy/socket', token: 'toy', privateRoot: '/toy', paths: { database: '/toy/db' },
    case: 'read-route', evaluation, endpoints: [],
  }, { fetch: async () => { effects++; assert.fail(); }, fixture: async () => { effects++; assert.fail(); } }), /unmapped_case/);
  assert.equal(effects, 0);
  assert.equal(population(evaluation).mapping.cases.length, 2);
});
