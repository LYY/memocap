const assert = require('node:assert/strict');
const test = require('node:test');
const { toy } = require('./evaluation-fixture.cjs');
const { createEvaluation } = require('./population.cjs');
const { inventory, createMeter, runLimits } = require('./inventory.cjs');
const { hash } = require('./value.cjs');
const profile = 'controlled_native_parent_genuine_curator_v1';
function evaluation() {
  const input = toy(); const raw = JSON.parse(input.input_utf8);
  raw.capture[0].turns.push(structuredClone(raw.capture[0].turns[0]));
  const entries = input.mapping.cases;
  raw.capture = Array.from({ length: 3 }, (_, index) => ({ ...structuredClone(raw.capture[0]), id: `toy-read-${index}` }));
  raw.maintenance = Array.from({ length: 3 }, (_, index) => ({ ...structuredClone(raw.maintenance[0]), id: `toy-update-${index}` }));
  input.mapping.cases = entries.flatMap((entry, kind) => Array.from({ length: 3 }, (_, index) => ({
    ...structuredClone(entry), id: `${entry.id}-${index}`, pointer: `/${kind ? 'maintenance' : 'capture'}/${index}` })));
  input.input_utf8 = JSON.stringify(raw); input.input_sha256 = hash(raw);
  input.mapping.tuning_sha256 = input.input_sha256; input.mapping_sha256 = hash(input.mapping);
  return createEvaluation(input);
}
const prior = { requests: 201, provider_requests: 201, parent_requests: 95, worker_requests: 106,
  provider_request_bytes: 1000, provider_response_bytes: 2000, host_opens: 74 };
function context(history = prior) {
  const input = evaluation(); const needed = inventory(input);
  const limits = { ...needed.limits, parent_requests: 0, requests: 36, provider_requests: 36,
    provider_request_bytes: 9437184, provider_response_bytes: 9437184,
    scripted_root_generations: needed.limits.parent_requests, scripted_root_dispatches: needed.limits.parent_requests,
    scripted_root_request_bytes: needed.limits.parent_requests * 262144,
    scripted_root_response_bytes: needed.limits.parent_requests * 262144 };
  const approval = { mode: 'native', approved: true, approval_id: 'toy-finite-round', limits,
    population_sha256: needed.tuning_sha256, inventory_sha256: hash(needed),
    evaluation_sha256: needed.evaluation_sha256, retained_ledger_sha256: hash(history) };
  const accounting = { retained_ledger: history, execution_profile: profile };
  return { input, approval, accounting, meter: () => createMeter(approval, 'native', input, accounting) };
}
test('201 historical requests permit 36 fresh workers while the 37th is blocked', () => {
  const fixture = context(); const meter = fixture.meter();
  for (let index = 0; index < 36; index++) {
    meter.charge('worker_requests'); meter.charge('requests'); meter.charge('provider_requests');
  }
  assert.equal(meter.snapshot().worker_requests, 36);
  assert.equal(meter.cumulativeSnapshot().requests, 237);
  assert.equal(meter.cumulativeSnapshot().worker_requests, 142);
  assert.throws(() => meter.charge('worker_requests'), /budget_worker_requests/);
  assert.equal(meter.snapshot().worker_requests, 36);
});
test('shared runLimits derives the controlled six-case twelve-workflow reservation', () => {
  const fixture = context();
  assert.deepEqual(runLimits(fixture.input, profile), fixture.approval.limits);
  assert.equal(inventory(fixture.input).limits.reviews, 12);
  assert.equal(runLimits(fixture.input).parent_requests, inventory(fixture.input).limits.parent_requests);
  assert.throws(() => runLimits(fixture.input, 'foreign'), /controlled_profile/);
});
test('history above the former 222 ceiling is preserved without consuming fresh slots', () => {
  const history = { ...prior, requests: 400, provider_requests: 400, worker_requests: 305 };
  const meter = context(history).meter(); meter.charge('worker_requests');
  assert.equal(meter.cumulativeSnapshot().requests, 400);
  assert.equal(meter.cumulativeSnapshot().worker_requests, 306);
  assert.equal(meter.cumulativeSnapshot().host_opens, 74);
});
for (const key of ['parent_requests', 'provider_request_bytes', 'provider_response_bytes',
  'scripted_root_generations', 'scripted_root_request_bytes', 'scripted_root_response_bytes']) {
  test(`fresh ${key} overflow fails without altering accepted accounting`, () => {
    const meter = context().meter(); meter.charge(key, meter.limits[key]);
    assert.throws(() => meter.charge(key), new RegExp(`budget_${key}`));
    assert.equal(meter.snapshot()[key], meter.limits[key]);
  });
}
test('elapsed deadline blocks fresh charge but permits charged cleanup', (t) => {
  t.mock.method(Date, 'now', () => 100);
  const meter = context().meter();
  Date.now.mock.mockImplementation(() => 101 + meter.limits.deadline_ms);
  assert.throws(() => meter.charge('worker_requests'), /population_deadline/);
  meter.charge('host_closes'); assert.deepEqual(meter.snapshot(), { host_closes: 1 });
});
test('exact-fit declared cumulative guard reserves prior plus all fresh dimensions', () => {
  const fixture = context(); fixture.approval.cumulative_limits = Object.fromEntries(
    Object.entries(fixture.approval.limits).map(([key, amount]) => [key, amount + (prior[key] ?? 0)]));
  const meter = fixture.meter(); meter.charge('requests', 36);
  assert.equal(meter.cumulativeSnapshot().requests, 237);
});
for (const key of ['requests', 'worker_requests', 'provider_request_bytes', 'host_opens', 'scripted_root_generations']) {
  test(`declared cumulative ${key} refuses insufficient worst-case reservation`, () => {
    const fixture = context(); fixture.approval.cumulative_limits = { [key]: (prior[key] ?? 0) + fixture.approval.limits[key] - 1 };
    assert.throws(fixture.meter, new RegExp(`budget_${key}`));
  });
}
for (const mutate of [
  (grant) => { delete grant.limits; }, (grant) => { delete grant.limits.worker_requests; },
  (grant) => { grant.limits.foreign = 1; }, (grant) => { grant.limits.parent_requests = 1; },
  (grant) => { grant.limits.worker_requests = 35; }, (grant) => { grant.limits.worker_requests = 37; },
  (grant) => { grant.limits.requests = Number.MAX_SAFE_INTEGER + 1; },
  (grant) => { grant.cumulative_limits = null; }, (grant) => { grant.cumulative_limits = {}; },
  (grant) => { grant.cumulative_limits = { foreign: 1 }; },
  (grant) => { grant.cumulative_limits = { requests: Number.MAX_SAFE_INTEGER + 1 }; },
]) test('malformed or nonexact finite limits are refused at meter creation', () => {
  const fixture = context(); mutate(fixture.approval);
  assert.throws(fixture.meter, /finite_evaluation_budget|population_budget_insufficient|invalid_cumulative_limits/);
});
test('safe integer cumulative sum is required even without a declared guard', () => {
  const fixture = context({ ...prior, host_opens: Number.MAX_SAFE_INTEGER });
  assert.throws(fixture.meter, /invalid_prior_spend/);
});
test('returned limits cannot raise the actual fresh enforcement ceiling', () => {
  const meter = context().meter();
  Reflect.set(meter.limits, 'worker_requests', 37);
  assert.throws(() => meter.charge('worker_requests', 37), /budget_worker_requests/);
});
for (const invalid of [false, '', 0]) test('unknown falsy profile is refused', () => {
  const fixture = context(); fixture.accounting.execution_profile = invalid;
  assert.throws(fixture.meter, /controlled_profile/);
});
