const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { hash } = require('./definitions.cjs');
const { annotations, population } = require('./examples.cjs');
const { createEvaluation } = require('../capture-quality-population-native/population.cjs');
const { toy, digest } = require('../capture-quality-population-native/evaluation-fixture.cjs');

function timeoutRun() {
  const input = toy(); const original = JSON.parse(input.input_utf8).maintenance[0];
  original.gold = { action: 'merge', mutations: 1 };
  input.input_utf8 = JSON.stringify({ capture: [], maintenance: [original] });
  input.input_sha256 = digest(input.input_utf8);
  input.mapping.cases = input.mapping.cases.filter(({ id }) => id === original.id);
  input.mapping.tuning_sha256 = input.input_sha256;
  input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  const evaluation = createEvaluation(input);
  const binding = { root: original.id, user: 'u1', workflow: 'maintenance' };
  const summary = { parentID: original.id, user_id: 'u1', workflow: 'maintenance',
    status: 'blocked', reason: 'maintenance_timeout', model_calls: 3, write_attempts: 0 };
  const clock = { ...binding, review_id: JSON.stringify([original.id, 'u1', 'maintenance']), clock_domain: 'node.performance:1' };
  const item = { id: original.id, original_sha256: hash(original), tuning_sha256: input.input_sha256,
    runtime: 'NOT_RUN', status: 'wired', cleanup: { exited: true, children: 0 },
    turns: [{ turn: 1, result: { reviews: [summary] } }],
    trace: { writes: [], saved_outputs: [], events: [
      { ...clock, kind: 'review.started', monotonic_ms: 1 },
      { ...binding, kind: 'model.response', usage: { tokens: {} } },
      { ...clock, ...summary, kind: 'review.finished', monotonic_ms: 30001 },
    ] } };
  return { evaluation, input: { population_status: 'complete', planned_case_ids: [item.id],
    attempted_case_ids: [item.id], completed_case_ids: [item.id], unexecuted_case_ids: [], case_failures: [], cases: [item],
    evaluation: { id: evaluation.id, input_sha256: evaluation.input_sha256,
      mapping_sha256: evaluation.mapping_sha256, evaluation_sha256: hash(evaluation) } } };
}

test('collect observes blocked timeout terminal without crediting the required merge', () => {
  const { input, evaluation } = timeoutRun();

  const result = collect(input, annotations(), evaluation);

  assert.deepEqual(result.inventory.reviews[0].missing, []);
  assert.equal(result.inventory.cases[0].complete, true);
  assert.equal(result.inventory.reviews[0].summaries[0].status, 'blocked');
  assert.equal(result.inventory.reviews[0].summaries[0].reason, 'maintenance_timeout');
  assert.equal(result.inventory.mutations.length, 0);
  assert.deepEqual([result.metrics.missed_maintenance.status, result.metrics.missed_maintenance.numerator,
    result.metrics.missed_maintenance.denominator], ['observed', 1, 1]);
  assert.equal(result.accounting.latency.status, 'blocked');
  assert.equal(result.accounting.latency.p50, null);
  assert.equal(result.metrics.unknown_rate.status, 'blocked');
  assert.equal(result.actual_quality.acceptance, null);
});

test('collect observes failed capture timeout without crediting a save', () => {
  const input = population();
  const item = input.cases.find(({ id }) => id === 'read-route');
  Object.assign(item.turns[0].result.reviews[0], { status: 'failed', reason: 'provider_timeout', write_attempts: 0 });

  const result = collect(input, annotations());

  const review = result.inventory.reviews.find(({ case_id }) => case_id === item.id);
  assert.deepEqual(review.missing, []);
  assert.equal(result.inventory.cases.find(({ id }) => id === item.id).complete, true);
  assert.equal(review.summaries[0].status, 'failed');
  assert.equal(review.summaries[0].reason, 'provider_timeout');
  assert.equal(result.inventory.attempts.length, 0);
  assert.equal(result.inventory.outputs.length, 0);
  assert.equal(result.inventory.mutations.length, 0);
  const coverage = result.metrics.capture_opportunity_coverage;
  assert.deepEqual([coverage.status, coverage.numerator, coverage.denominator], ['observed', 0, 8]);
});

for (const variant of ['absent', 'duplicate', 'unrecognized']) test(`collect rejects ${variant} terminal summary`, () => {
  const { input, evaluation } = timeoutRun();
  const summaries = input.cases[0].turns[0].result.reviews;
  if (variant === 'absent') summaries.length = 0;
  if (variant === 'duplicate') summaries.push(structuredClone(summaries[0]));
  if (variant === 'unrecognized') summaries[0].status = 'not-a-terminal';

  const result = collect(input, annotations(), evaluation);

  assert.equal(result.inventory.reviews[0].missing.includes('review:terminal'), true);
  assert.equal(result.inventory.cases[0].complete, false);
  assert.equal(result.metrics.missed_maintenance.status, 'blocked');
});

test('collect still requires native commit and readback for a blocked review with a dispatch', () => {
  const { input, evaluation } = timeoutRun();
  input.cases[0].trace.events.push({ kind: 'native.dispatch', attempt: 'uncommitted',
    root: input.cases[0].id, user: 'u1', workflow: 'maintenance', tool: 'memocap_maintain' });

  const result = collect(input, annotations(), evaluation);

  assert.equal(result.inventory.attempts[0].verified, false);
  assert.equal(result.inventory.mutations.length, 0);
  assert.equal(result.metrics.missed_maintenance.status, 'blocked');
  assert.equal(result.metrics.missed_maintenance.adjudicated_numerator, 1);
});
