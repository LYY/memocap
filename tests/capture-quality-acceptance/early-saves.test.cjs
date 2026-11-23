const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { population, save, annotations, outputJudgment, judged } = require('./examples.cjs');

test('qualified earlier save covers the original opportunity and atomic claim', () => {
  const input = population(); save(input, 'same-task-third-turn', 1);
  const labels = annotations();
  labels.outputs = collect(input).inventory.outputs.map((row) => outputJudgment(row, [0]));

  const result = collect(input, labels);

  assert.equal(result.inventory.outputs[0].verified, true);
  assert.deepEqual(result.inventory.outputs[0].judgment_missing, []);
  assert.deepEqual([result.metrics.capture_opportunity_coverage.numerator, result.metrics.capture_opportunity_coverage.denominator], [1, 8]);
  assert.deepEqual([result.metrics.atomic_claim_coverage.numerator, result.metrics.atomic_claim_coverage.denominator], [1, 9]);
  assert.equal(result.actual_quality.status, 'not_run');
});

test('repeated qualified saves across turns credit each original claim only once', () => {
  const input = population();
  for (const turn of [1, 2, 3]) save(input, 'same-task-third-turn', turn);
  const labels = annotations();
  labels.outputs = collect(input).inventory.outputs.map((row) => outputJudgment(row, [0]));

  const result = collect(input, labels);

  assert.equal(result.inventory.outputs.length, 3);
  assert.deepEqual([result.metrics.capture_admission_precision.numerator, result.metrics.capture_admission_precision.denominator], [3, 3]);
  assert.equal(result.metrics.capture_opportunity_coverage.numerator, 1);
  assert.equal(result.metrics.atomic_claim_coverage.numerator, 1);
});

for (const defect of ['invalid-context', 'ephemeral', 'unsupported', 'lost-condition']) {
  test(`earlier save with ${defect} receives no coverage credit`, () => {
    const input = population(); save(input, 'same-task-third-turn', 1);
    const labels = annotations(); const label = outputJudgment(collect(input).inventory.outputs[0], [0]);
    if (defect === 'invalid-context') label.context = 'invalid';
    if (defect === 'ephemeral') label.durability = 'ephemeral';
    if (defect === 'unsupported') label.claims[0].support = 'unsupported';
    if (defect === 'lost-condition') label.conditions[0].preserved = false;
    labels.outputs.push(label);

    const result = collect(input, labels);

    assert.equal(result.metrics.capture_opportunity_coverage.numerator, 0);
    assert.equal(result.metrics.atomic_claim_coverage.numerator, 0);
    assert.equal(result.metrics.capture_admission_precision.numerator, 0);
  });
}

test('earlier alpha review cannot enter current beta false-continuity scoring', () => {
  const input = population(); const item = save(input, 'switch-beta', 1);
  for (const turn of [1, 2]) item.trace.events.push({ kind: 'model.response', root: item.id, user: `u${turn}`, workflow: 'capture' });
  input.cases.find((row) => row.id === 'unknown-followup').trace.events.push({ kind: 'model.response', root: 'unknown-followup', user: 'u2', workflow: 'capture' });
  const labels = annotations(); const inventory = collect(input).inventory;
  labels.outputs = inventory.outputs.map((row) => outputJudgment(row));
  labels.reviews = inventory.reviews.filter((row) => row.semantic).map((row) => ({ ...judged(row.key), unknown: false, false_continuity: row.turn === 1 }));

  const result = collect(input, labels);

  assert.deepEqual([result.metrics.false_continuity.status, result.metrics.false_continuity.numerator, result.metrics.false_continuity.denominator], ['observed', 0, 2]);
  assert.equal(result.metrics.capture_opportunity_coverage.numerator, 0);
});
