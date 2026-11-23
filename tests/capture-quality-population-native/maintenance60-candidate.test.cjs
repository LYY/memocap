const test = require('node:test');
const assert = require('node:assert/strict');
const { createEvaluation, population } = require('./population.cjs');
const { toy } = require('./evaluation-fixture.cjs');
const { executionProfile, bindExecutionProfile } = require('./execution-profile.cjs');
const { inventory, createMeter } = require('./inventory.cjs');
const { runCase } = require('./adapter.cjs');
const { fakeHost } = require('./fake-host.cjs');
const { createWorkflows } = require('./workflows.cjs');
const { authorize } = require('./authorization.cjs');
const { hash } = require('./value.cjs');

for (const captureExecutionMs of [30000, 45000, 60000]) test(`maintenance60 canonical descriptor grant adapter collection with capture${captureExecutionMs}`, async () => {
  const selected = population(createEvaluation({ ...toy(), captureExecutionMs, maintenanceExecutionMs: 60000 }));
  const needed = inventory(selected);
  const canonical = executionProfile(selected);
  const prior = { requests: 0, parent_requests: 0, worker_requests: 0, provider_requests: 0,
    provider_request_bytes: 0, provider_response_bytes: 0 };
  const grant = { mode: 'native', approved: true, approval_id: 'synthetic-only', captureExecutionMs,
    maintenanceExecutionMs: 60000, population_sha256: needed.tuning_sha256, inventory_sha256: hash(needed),
    evaluation_sha256: needed.evaluation_sha256, limits: needed.limits, retained_ledger_sha256: hash(prior) };
  assert.equal(bindExecutionProfile({ captureExecutionMs, maintenanceExecutionMs: 60000 }, grant, selected), canonical);
  const meter = createMeter(grant, 'native', selected, { retained_ledger: prior });
  assert.throws(() => createMeter({ ...grant, maintenanceExecutionMs: 45000,
    get limits() { return assert.fail('meter consumed mismatched grant'); } }, 'native', selected),
  { code: 'capture_execution_profile_mismatch' });
  meter.charge('worker_requests');
  assert.equal(meter.snapshot().worker_requests, 1);
  const host = fakeHost();
  const opens = []; const settles = []; const open = host.open; const settle = host.settle;
  host.open = (request) => { opens.push(request); return open(request); };
  host.settle = async (request) => { settles.push(request); return { ...await settle(request), capture_execution_profile: canonical }; };

  const result = await runCase('toy-update', { population: selected, host, budget: { mode: 'offline' } });

  assert.equal(result.status, 'wired', result.reason);
  assert.deepEqual(result.capture_execution_profile, canonical);
  assert.equal(opens[0].maintenanceExecutionMs, 60000);
  assert.equal(opens[0].timeout_ms, 165000 + captureExecutionMs);
  assert.equal(settles[0].timeout_ms, 63000 + captureExecutionMs);
  assert.equal(settles[0].maintenanceExecutionMs, 60000);
  assert.equal(needed.limits.deadline_ms, 234000 + 2 * captureExecutionMs);
  assert.equal(host.stats.provider_requests, 0);
  assert.equal(host.stats.native_processes, 0);
});

for (const maintenanceExecutionMs of [45000, 61000]) test(`maintenance60 rejects mismatched or unsupported ${maintenanceExecutionMs} before host or grant consumption`, async () => {
  const selected = population(createEvaluation({ ...toy(), captureExecutionMs: 45000, maintenanceExecutionMs: 60000 }));
  const code = maintenanceExecutionMs === 61000 ? 'maintenance_execution_profile' : 'capture_execution_profile_mismatch';
  await assert.rejects(runCase('toy-update', { population: selected, maintenanceExecutionMs,
    get host() { return assert.fail('host accessed before profile rejection'); } }), { code });
  assert.throws(() => authorize({ evaluation: selected.descriptor, captureExecutionMs: 45000, maintenanceExecutionMs,
    get paths() { return assert.fail('consumption paths accessed'); } }, { kind: 'quality-full-population-native-v1',
    approved: true, authorization: 'new-explicit-user-grant', mode: 'native', approval_id: 'synthetic-only-grant',
    captureExecutionMs: 45000, maintenanceExecutionMs: 60000 }), { code });
});

test('maintenance60 does not renew or raise generation child or write budgets', () => {
  let now = 0;
  const workflows = createWorkflows(() => now, 45000, 60000);
  const active = { root: 'root', user: 'user' };
  const owner = workflows.start(active, 'maintenance');
  now = 10000;
  workflows.child(active, 'memocap maintenance review');
  workflows.child(active, 'memocap maintenance commit');
  workflows.generation(owner); workflows.generation(owner); workflows.generation(owner);
  workflows.dispatch({ ...active, workflow: 'maintenance', session: 'commit' });
  assert.throws(() => workflows.child(active, 'memocap maintenance commit'), { code: 'child_binding_or_budget' });
  assert.throws(() => workflows.generation(owner), { code: 'review_generation_budget' });
  assert.throws(() => workflows.dispatch({ ...active, workflow: 'maintenance', session: 'commit' }), { code: 'review_write_budget' });
  now = 60000;
  assert.throws(() => workflows.dispatch({ ...active, workflow: 'maintenance', session: 'commit' }), { code: 'review_deadline' });
  assert.throws(() => workflows.start(active, 'maintenance'), { code: 'review_execution_rearmed' });
});
