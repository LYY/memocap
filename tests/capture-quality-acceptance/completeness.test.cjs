const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { population, save, annotations, outputJudgment } = require('./examples.cjs');
test('real workflow objects preserve each maintenance review without adding phantom capture reviews', () => {
  const input = population(); const item = input.cases[16];
  item.turns[0].result.reviews[0].workflow = 'maintenance';
  item.trace.reviews[0].workflows = { capture: { stages: [], missing: ['raw'] }, maintenance: { stages: ['raw'], missing: ['native.dispatch'] } };
  const result = collect(input, annotations());
  assert.equal(result.inventory.cases[16].complete, true);
  assert.deepEqual(result.inventory.reviews.filter((row) => row.case_id === item.id).map((row) => row.lane), ['maintenance']);
});
test('proposal terminal with no issuance blocks decision denominator rather than reporting empty N/A', () => {
  const input = population(); const review = input.cases[16].turns[0].result.reviews[0];
  review.workflow = 'maintenance'; review.status = 'proposal';
  const result = collect(input, annotations());
  assert.equal(result.metrics.maintenance_false_revision.status, 'blocked');
  assert.equal(result.metrics.maintenance_false_revision.denominator, null);
});
test('saved terminal with absent native observations blocks empty precision', () => {
  const input = population(); input.cases[0].turns[0].result.reviews[0].status = 'saved';
  const result = collect(input, annotations());
  assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
});
test('unsupported extra claim remains in support denominator without erasing a correct original claim', () => {
  const input = population(); save(input, 'read-route'); const labels = annotations();
  const label = outputJudgment(collect(input, labels).inventory.outputs[0], [0]);
  label.claims.push({ id: 'extra', text: 'Unfounded business completion.', support: 'unsupported', gold_claim: null, rationale: 'No completion evidence.' });
  labels.outputs.push(label);
  const result = collect(input, labels);
  assert.equal(result.metrics.capture_admission_precision.numerator, 0);
  assert.equal(result.metrics.atomic_claim_coverage.numerator, 1);
  assert.equal(result.metrics.incorrect_support_rate.denominator, 2);
  assert.equal(result.metrics.incorrect_support_rate.numerator, 1);
});
test('setup seeds remain separate from all review output denominators', () => {
  const input = population(); input.cases[16].seeds.push({ setup_only: true, id: 99, placement: 'synthetic', content: 'Seed fact.' });
  const result = collect(input, annotations());
  assert.equal(result.inventory.seeds.length, 1);
  assert.equal(result.metrics.capture_admission_precision.denominator, 0);
});
test('collector is deterministic and does not mutate native receipts or annotation input', () => {
  const input = population(); save(input, 'read-route'); const labels = annotations();
  labels.outputs.push(outputJudgment(collect(input, labels).inventory.outputs[0], [0]));
  const before = JSON.stringify([input, labels]);
  const first = collect(input, labels); const second = collect(input, labels);
  assert.deepEqual(first, second); assert.equal(JSON.stringify([input, labels]), before);
});
test('orphan native tool receipt remains a saved output and blocks false empty precision', () => {
  const input = population();
  input.cases[0].trace.events.push({ kind: 'tool.output', root: 'read-route', user: 'u1', workflow: 'capture',
    tool: 'memocap_remember', session: 'child', message: 'm', receipt: { status: 'inserted', results: [
      { memory: { id: 51, placement: 'synthetic', content: 'Actual synthetic tool output.' }, completeness: 'full' }] } });
  const result = collect(input, annotations());
  assert.equal(result.inventory.outputs.length, 1);
  assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
  assert.equal(result.metrics.capture_admission_precision.denominator, null);
});
