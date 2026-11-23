const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const file = path.join(__dirname, 'runtime.cjs');
const local = createRequire(file);
const ids = require('./population.cjs').tuningPopulation.mapping.cases.map(({ id }) => id);
function runtime(runCase, { cli = false, cleanupFailure = false, realMeter = false } = {}) {
  const module = { exports: {} }; let opened = 0; let attempts = 0; let removed = 0; let stdout = '';
  const selectedKind = 'quality-full-population-native-selected-v1-r8';
  const authorize = () => ({ limits: local('./inventory.cjs').inventory().limits });
  const deps = { 'node:fs': { writeFileSync() { attempts++; }, mkdirSync() {}, readdirSync() {
    if (cleanupFailure) throw new Error('synthetic_cleanup_error'); return ['recovery'];
  }, rmdirSync() { removed++; },
    readFileSync: () => JSON.stringify({ paths: { attempt: '/synthetic/attempt', privateRoot: '/synthetic/root' } }) },
  './authorization.cjs': { authorize, authorizeSelectedV1: (_input, grant) => ({ ...authorize(), ...grant, kind: selectedKind }),
    selectedV1Kind: selectedKind, sources: () => ({ digest: 'synthetic' }) },
  './concrete-host.cjs': { concreteHost() { opened++; return {}; } },
  './inventory.cjs': { inventory: local('./inventory.cjs').inventory, createMeter: () => realMeter ?
    local('./inventory.cjs').createMeter({ mode: 'offline' }, 'offline') : { snapshot: () => ({ observed: 1 }) } },
   './population.cjs': local('./population.cjs'), './permission-configuration.cjs': local('./permission-configuration.cjs'), './adapter.cjs': { runCase },
  './value.cjs': local('./value.cjs'), './execution-profile.cjs': local('./execution-profile.cjs') };
  const requireFake = (name) => deps[name]; requireFake.main = cli ? module : null;
  const processFake = { argv: ['node', file, '--run', 'synthetic-input', 'synthetic-grant'], exitCode: 0,
    stdout: { write(value) { stdout += value; } }, stderr: { write() {} } };
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', 'process'], { filename: file })(requireFake, module, module.exports, processFake);
  const paths = { attempt: '/synthetic/attempt', privateRoot: '/synthetic/root' };
  return { run: (prior) => module.exports.runNative({ paths }, {}, prior),
    runSelected: (prior) => module.exports.runSelectedV1R8({ paths, execution_profile: 'controlled_native_parent_genuine_curator_v1' },
      { retained_ledger_sha256: local('./value.cjs').hash(prior) }, prior),
    state: () => ({ opened, attempts, removed, stdout, exitCode: processFake.exitCode }) };
}
const safe = (id) => ({ id, status: 'blocked', reason: 'missing_observation',
  cleanup: { exited: true, children: 0, removed: true, control_stopped: true, listener_closed: true },
  trace: { events: [], recovery_required: false } });

for (const [reason, override] of [
  ['unknown_write', { trace: { events: [{ kind: 'native.dispatch' }], recovery_required: true } }],
  ['unknown_exit', { cleanup: { exited: false } }],
  ['unknown_setup_write', { setup_recovery_required: true }],
  ['unknown_cleanup', { cleanup: { ...safe(ids[0]).cleanup, children: 1 } }],
]) test(`reports all untouched original IDs when first case stops for ${reason}`, async () => {
  const observed = { ...safe(ids[0]), ...override }; const runner = runtime(async () => observed);
  const result = await runner.run();
  assert.equal(result.population_status, 'incomplete'); assert.deepEqual(result.planned_case_ids, ids);
  assert.deepEqual(result.completed_case_ids, [ids[0]]); assert.deepEqual(result.unexecuted_case_ids, ids.slice(1));
  assert.equal(result.stop_reason, reason); assert.equal(result.stopped_case_id, ids[0]);
  assert.deepEqual(result.cases, [observed]); assert.equal(result.quality_credit, false);
  assert.deepEqual(result.counts, { planned: 28, attempted: 1, completed: 1, unexecuted: 27 });
  assert.deepEqual(runner.state(), { opened: 1, attempts: 1, removed: 0, stdout: '', exitCode: 0 });
});

const priorSpend = Object.freeze({ requests: 32, parent_requests: 32, provider_requests: 32,
  provider_request_bytes: 345236, provider_response_bytes: 1363237 });
test('selected host identity failure stops before a second case even with known cleanup', async () => {
  const runner = runtime(async (id) => ({ ...safe(id), reason: 'native_session_identity' }), { realMeter: true });
  const result = await runner.runSelected({ requests: 0, parent_requests: 0, worker_requests: 0, provider_requests: 0,
    provider_request_bytes: 0, provider_response_bytes: 0 });
  assert.equal(result.stop_reason, 'native_session_identity');
  assert.deepEqual(result.unexecuted_case_ids, ids.slice(1));
  assert.equal(runner.state().opened, 1);
});
test('continuation precharges only measured provider spend and returns fresh deltas', async () => {
  const runner = runtime(async (id, { meter }) => {
    if (id === ids[0]) {
      for (const key of ['requests', 'parent_requests', 'provider_requests', 'host_opens']) meter.charge(key);
      meter.charge('provider_request_bytes', 7); meter.charge('provider_response_bytes', 11);
    }
    return safe(id);
  }, { realMeter: true });
  const result = await runner.run(priorSpend);
  assert.equal(result.population_status, 'complete');
  assert.deepEqual(result.budget_prior_used, priorSpend);
  assert.deepEqual(result.budget_used, { requests: 1, parent_requests: 1, provider_requests: 1,
    provider_request_bytes: 7, provider_response_bytes: 11, host_opens: 1 });
  assert.deepEqual(result.budget_cumulative_used, { requests: 33, parent_requests: 33, provider_requests: 33,
    provider_request_bytes: 345243, provider_response_bytes: 1363248, host_opens: 1 });
});
test('genuinely fresh runs have no prior spend', async () => {
  const result = await runtime(async (id, { meter }) => { meter.charge('host_opens'); return safe(id); }, { realMeter: true }).run();
  assert.deepEqual(result.budget_prior_used, {});
  assert.deepEqual(result.budget_used, { host_opens: 28 });
  assert.deepEqual(result.budget_cumulative_used, result.budget_used);
});
test('continuation case snapshots retain only this batch counters', async () => {
  const result = await runtime(async (id, { meter }) => {
    meter.charge('requests'); meter.charge('parent_requests'); meter.charge('provider_requests');
    return { ...safe(id), budget_used: meter.snapshot() };
  }, { realMeter: true }).run(priorSpend);
  assert.equal(result.cases[0].budget_used.requests, 1);
  assert.equal(result.cases[27].budget_used.requests, 28);
  assert.equal(result.cases[0].budget_used.provider_request_bytes ?? 0, 0);
  assert.equal(result.budget_cumulative_used.requests, 60);
});
for (const [key, remaining] of [['requests', 190], ['provider_requests', 190], ['parent_requests', 67],
  ['provider_request_bytes', 57850732], ['provider_response_bytes', 56832731]]) {
  test(`continuation refuses ${key} beyond exact remaining capacity before dispatch`, async () => {
    let dispatches = 0;
    const runner = runtime(async (id, { meter }) => {
      meter.charge(key, remaining); dispatches++;
      meter.charge(key); dispatches++;
      return safe(id);
    }, { realMeter: true });
    const result = await runner.run(priorSpend);
    assert.equal(dispatches, 1); assert.equal(result.stop_reason, `budget_${key}`);
    assert.equal(result.budget_used[key], remaining);
    assert.equal(result.budget_cumulative_used[key], priorSpend[key] + remaining);
    assert.deepEqual(result.planned_case_ids, ids); assert.deepEqual(result.unexecuted_case_ids, ids.slice(1));
    assert.equal(runner.state().opened, 1);
  });
}
for (const prior of [null, [], 32, { requests: 32 }, { ...priorSpend, worker_requests: 1 },
  { ...priorSpend, host_opens: -1 }, { ...priorSpend, requests: -1 }, { ...priorSpend, requests: 1.5 },
  { ...priorSpend, provider_response_bytes: Number.MAX_SAFE_INTEGER + 1 }, { ...priorSpend, provider_requests: 31 },
  { ...priorSpend, parent_requests: 33 }, { ...priorSpend, provider_request_bytes: '345236' }]) {
  test(`malformed prior spend is refused before attempt or host effects ${JSON.stringify(prior)}`, async () => {
    const runner = runtime(async (id) => safe(id), { realMeter: true });
    await assert.rejects(runner.run(prior), { code: 'invalid_prior_spend' });
    assert.equal(runner.state().attempts, 0); assert.equal(runner.state().opened, 0);
  });
}
test('over-cap prior spend is refused by existing meter before attempt effects', async () => {
  const runner = runtime(async (id) => safe(id), { realMeter: true });
  await assert.rejects(runner.run({ ...priorSpend, requests: 223, parent_requests: 223, provider_requests: 223 }), { code: 'budget_requests' });
  assert.equal(runner.state().attempts, 0); assert.equal(runner.state().opened, 0);
});

for (const field of ['children', 'removed', 'control_stopped', 'listener_closed']) test(`missing cleanup ${field} stops before another original host`, async () => {
  const observed = safe(ids[0]); delete observed.cleanup[field];
  const runner = runtime(async () => observed);
  const result = await runner.run();
  assert.equal(result.stop_reason, 'unknown_cleanup'); assert.equal(result.stopped_case_id, ids[0]);
  assert.deepEqual(result.cases, [observed]); assert.deepEqual(result.unexecuted_case_ids, ids.slice(1));
  assert.equal(runner.state().opened, 1); assert.equal(runner.state().removed, 0);
});

test('reports complete visitation without assigning semantic credit for safe known failures', async () => {
  const result = await runtime(async (id) => safe(id)).run();
  assert.equal(result.population_status, 'complete'); assert.deepEqual(result.completed_case_ids, ids);
  assert.deepEqual(result.unexecuted_case_ids, []); assert.equal(result.stop_reason, null); assert.equal(result.quality_credit, false);
});

test('case throw retains case identity and unknown recovery without fabricating terminal reports', async () => {
  const runner = runtime(async (id) => { if (id === ids[1]) throw new Error('synthetic'); return safe(id); });
  const result = await runner.run();
  assert.equal(result.population_status, 'incomplete'); assert.equal(result.stopped_case_id, ids[1]);
  assert.deepEqual(result.completed_case_ids, [ids[0]]); assert.deepEqual(result.attempted_case_ids, ids.slice(0, 2));
  assert.deepEqual(result.unexecuted_case_ids, ids.slice(2)); assert.equal(result.case_failures[0].recovery_required, true);
  assert.equal(result.case_failures[0].id, ids[1]); assert.equal(result.cases.length, 1); assert.equal(runner.state().opened, 2);
});

test('CLI prints incomplete population result and sets non-success exit without runtime IO', async () => {
  const runner = runtime(async (id) => ({ ...safe(id), setup_recovery_required: true }), { cli: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.state().exitCode, 1);
  assert.equal(JSON.parse(runner.state().stdout).population_status, 'incomplete');
});

test('root cleanup failure preserves already returned cases and signals incomplete', async () => {
  const runner = runtime(async (id) => safe(id), { cleanupFailure: true });
  const result = await runner.run();
  assert.equal(result.population_status, 'incomplete'); assert.equal(result.stop_reason, 'private_root_cleanup_failed');
  assert.deepEqual(result.completed_case_ids, ids); assert.deepEqual(result.unexecuted_case_ids, []);
  assert.equal(result.case_failures[0].reason, 'private_root_cleanup_failed'); assert.equal(result.cases.length, 28);
  assert.equal(runner.state().removed, 0);
});
