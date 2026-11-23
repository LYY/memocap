const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalFixture } = require('./execution-terminal-fixture.cjs');
const { runCase } = require('./adapter.cjs');
const { createEvaluation } = require('./population.cjs');
const { toy } = require('./evaluation-fixture.cjs');
const { inventory, runLimits, createMeter } = require('./inventory.cjs');
const { hash } = require('./value.cjs');
const offline = { mode: 'offline', approved: false };

for (const captureExecutionMs of [30000, 45000, 60000]) {
  for (const emit of [true, false]) test(`${captureExecutionMs} public collection ${emit ? 'accepts late terminal' : 'bounds absent terminal'}`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const current = await terminalFixture(captureExecutionMs, emit);
    context.after(current.dispose);
    const running = runCase('same-task-third-turn', { host: current.host, budget: offline, captureExecutionMs });
    await current.waiting; await new Promise(setImmediate);
    context.mock.timers.tick(captureExecutionMs + (emit ? 318 : 3000));
    const result = await running;
    assert.equal(result.status, emit ? 'wired' : 'blocked', result.reason);
    assert.equal(result.reason, emit ? null : 'review_deadline');
    assert.equal(result.turns.length, emit ? 3 : 0);
    assert.equal(result.cleanup.exited, true);
    if (emit) assert.equal(result.turns[0].result.capture_execution_profile.capture_ms, captureExecutionMs);
  });
  test(`${captureExecutionMs} exact selected grant and fresh meter agree`, () => {
    const evaluation = createEvaluation({ ...toy(), captureExecutionMs }); const needed = inventory(evaluation);
    const prior = { worker_requests: 0, requests: 0, provider_requests: 0, parent_requests: 0,
      provider_request_bytes: 0, provider_response_bytes: 0 }; const accounting = { retained_ledger: prior, captureExecutionMs };
    const grant = { mode: 'native', approved: true, approval_id: 'inert-meter', captureExecutionMs,
      limits: runLimits(evaluation), inventory_sha256: hash(needed), population_sha256: needed.tuning_sha256,
      evaluation_sha256: needed.evaluation_sha256, retained_ledger_sha256: hash(prior) };
    const meter = createMeter(grant, 'native', evaluation, accounting);
    meter.charge('worker_requests', grant.limits.worker_requests);
    assert.throws(() => meter.charge('worker_requests'), /budget_worker_requests/);
    assert.throws(() => createMeter({ ...grant, captureExecutionMs: captureExecutionMs === 45000 ? 60000 : 45000 }, 'native', evaluation, accounting), /capture_execution_profile_mismatch/);
  });
}
test('terminal profile mismatch cannot resolve review collection', async (context) => {
  const current = await terminalFixture(45000); context.after(current.dispose);
  await current.call('bind', { root: 'root', review: true, captureExecutionMs: 45000 });
  assert.throws(() => current.emit({ parentID: 'root', user_id: 'user', workflow: 'capture',
    execution_profile: require('../../plugin/capture/execution-profile.js').captureExecutionProfile(30000) }), /capture_execution_profile_mismatch/);
});
test('descriptor and grant mismatch is refused before runtime inputs are read', () => {
  const evaluation = createEvaluation({ ...toy(), captureExecutionMs: 45000 });
  const input = { evaluation, get network_binding() { return assert.fail('effects boundary reached'); } };
  assert.throws(() => require('./authorization.cjs').authorize(input, { kind: 'quality-full-population-native-v1',
    approved: true, authorization: 'approved-work', mode: 'native', approval_id: 'inert-approval-0123456789',
    captureExecutionMs: 30000, evaluation_sha256: hash(evaluation) }), /capture_execution_profile_mismatch/);
});
