const assert = require('node:assert/strict');
const test = require('node:test');
const { mapping } = require('../capture-quality-population/inputs.cjs');
const { runOffline } = require('./driver.cjs');

test('public offline driver completes the frozen population when a whole secret unit is screened', async () => {
  const report = await runOffline();
  assert.equal(report.status, 'offline_wiring_verified');
  assert.deepEqual(report.cases.map((row) => row.id), mapping.cases.map((row) => row.id));
  assert.deepEqual(report.frozen, { sha256: mapping.tuning_sha256, cases: 28, capture: 16,
    capture_opportunities: 8, capture_claims: 9, maintenance: 12, authorized_mutations: 2 });
  const screened = report.cases.find((row) => row.id === 'synthetic-secret');
  assert.deepEqual(screened.turns.map((turn) => turn.status), ['screened_whole_unit']);
  assert.deepEqual(screened.turns.map((turn) => turn.semantic), ['unexercised']);
  assert.equal(screened.transport, null); assert.equal(screened.trace, null); assert.equal(screened.cleanup, null);
  assert.deepEqual(screened.custody, []); assert.deepEqual(screened.seeds, []);
  assert.deepEqual(screened.setup_attempts, []); assert.deepEqual(screened.completion_evidence, []);
  assert.equal(report.adversaries.length, 23);
  assert.equal(report.cases.every((row) => row.status === 'wired' && row.runtime === 'NOT_RUN' && row.quality_credit === false), true);
  assert.deepEqual(report.execution, { native_host: 'NOT_RUN', model: 'NOT_RUN', sqlite: 'NOT_RUN', provider_requests: 0,
    native_processes: 0, sockets: 0, materializations: 0, holdout_decoded: false, qa7: 'NOT_RUN', quality_credit: false });
});
