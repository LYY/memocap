const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { population, save, annotations, outputJudgment, judged } = require('./examples.cjs');
test('no run retains null precision while a fully observed empty population is N/A', () => {
  const absent = collect(null);
  const empty = collect(population(), annotations());
  assert.deepEqual([absent.metrics.capture_admission_precision.status, absent.metrics.capture_admission_precision.denominator], ['not_run', null]);
  assert.deepEqual([empty.metrics.capture_admission_precision.status, empty.metrics.capture_admission_precision.denominator], ['not_applicable', 0]);
  assert.equal(empty.actual_quality.status, 'not_run');
});
test('unknown dispatched write cannot become empty saved precision', () => {
  const input = population();
  input.cases[0].trace.events.push({ kind: 'native.dispatch', attempt: 'lost', workflow: 'capture', root: 'read-route', user: 'u1' });
  const result = collect(input, annotations());
  assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
  assert.equal(result.inventory.attempts.length, 1);
  assert.equal(result.metrics.capture_admission_precision.denominator, null);
});
test('all negative and earlier-turn saves enter precision, independently of frozen skip gold', () => {
  const input = population();
  save(input, 'dropped-condition'); save(input, 'switch-beta', 1);
  const first = collect(input, annotations());
  const labels = annotations(); labels.outputs = first.inventory.outputs.map((row) => outputJudgment(row));
  const result = collect(input, labels);
  assert.equal(result.metrics.capture_admission_precision.value, 1);
  assert.equal(result.metrics.capture_admission_precision.denominator, 2);
  assert.equal(result.metrics.capture_opportunity_coverage.numerator, 0);
  assert.equal(result.inventory.outputs.find((row) => row.case_id === 'switch-beta').turn, 1);
});
test('valid rejected and no-candidate no-write terminals ignore ledger missing successful stages', () => {
  const input = population(); input.cases[0].turns[0].result.reviews[0].status = 'rejected';
  const result = collect(input, annotations());
  assert.equal(result.inventory.cases[0].complete, true);
  assert.equal(result.metrics.capture_admission_precision.status, 'not_applicable');
});
test('incomplete population preserves original 8,9,2 denominators', () => {
  const input = population(); input.population_status = 'incomplete'; input.cases = input.cases.slice(0, 1);
  input.completed_case_ids = ['read-route']; input.attempted_case_ids = ['read-route'];
  input.unexecuted_case_ids = input.planned_case_ids.slice(1);
  const result = collect(input, annotations());
  for (const [name, denominator] of [['capture_opportunity_coverage', 8], ['atomic_claim_coverage', 9], ['missed_maintenance', 2]]) {
    assert.equal(result.metrics[name].denominator, denominator); assert.equal(result.metrics[name].status, 'blocked');
  }
});
test('combined identity save covers two claims but only one opportunity and no replay decision', () => {
  const input = population(); save(input, 'same-source-distinct-claims');
  const labels = annotations(); const row = collect(input, labels).inventory.outputs[0];
  labels.outputs.push(outputJudgment(row, [0, 1]));
  const result = collect(input, labels);
  assert.equal(result.metrics.atomic_claim_coverage.numerator, 2);
  assert.equal(result.metrics.capture_opportunity_coverage.numerator, 1);
  assert.equal(result.identity.identical_replay.exercise, 'unexercised');
  assert.equal(result.metrics.exact_duplicate_error.status, 'blocked');
});
test('lost conditions remain in eligible denominator and prevent correct capture', () => {
  const input = population(); save(input, 'read-route');
  const labels = annotations(); labels.outputs = [outputJudgment(collect(input, labels).inventory.outputs[0], [0])];
  labels.outputs[0].conditions[1].preserved = false;
  const result = collect(input, labels);
  assert.equal(result.metrics.condition_retention.denominator, 3);
  assert.equal(result.metrics.condition_retention.numerator, 2);
  assert.equal(result.metrics.capture_admission_precision.numerator, 0);
});
for (const variant of ['missing', 'duplicate', 'foreign', 'disagreement']) test(`${variant} annotation fails closed without shrinking output count`, () => {
  const input = population(); save(input, 'read-route');
  const labels = annotations(); const label = outputJudgment(collect(input, labels).inventory.outputs[0], [0]);
  if (variant !== 'missing') labels.outputs.push(label);
  if (variant === 'duplicate') labels.outputs.push(structuredClone(label));
  if (variant === 'foreign') labels.outputs.push({ ...label, key: 'foreign' });
  if (variant === 'disagreement') label.resolution = 'disagreement';
  const result = collect(input, labels);
  assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
  assert.equal(result.metrics.capture_admission_precision.denominator, 1);
});
test('semantic unknown counts per reviewed case and keeps lanes inspectable', () => {
  const input = population(); const item = input.cases[0];
  item.trace.events.push({ kind: 'model.response', root: item.id, user: 'u1', workflow: 'capture', usage: { tokens: {} } });
  const labels = annotations(); const row = collect(input, labels).inventory.reviews.find((entry) => entry.semantic);
  labels.reviews.push({ ...judged(row.key), unknown: true });
  const result = collect(input, labels);
  assert.equal(result.groups.find((group) => group.family === 'source-acquisition' && group.lane === 'capture').unknown.value, 1);
  assert.equal(result.accounting.tokens.input, null); assert.equal(result.accounting.cost, null);
});
test('response latency never substitutes for missing completed-review timing', () => {
  const input = population(); input.cases[0].trace.events.push({ kind: 'model.response', root: 'read-route', user: 'u1',
    workflow: 'capture', usage: { latency_ms: 17, tokens: { input: 10, output: 2 }, reported_cost: null, cost: null } });
  const result = collect(input, annotations());
  assert.equal(result.accounting.latency.status, 'blocked'); assert.equal(result.accounting.latency.p50, null);
  assert.equal(result.accounting.cost, null);
});
test('nearest-rank estimator selects ceil(p*n)-1 including even and tail samples', () => {
  const { quantile } = require('./statistics.cjs');
  assert.equal(quantile([40, 10, 30, 20], 0.5), 20);
  assert.equal(quantile(Array.from({ length: 20 }, (_, index) => index + 1), 0.95), 19);
  assert.equal(quantile([], 0.5), null);
});
