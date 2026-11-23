const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { population, save, annotations, outputJudgment } = require('./examples.cjs');
const absent = collect(null);
const completeEmpty = collect(population(), annotations());
const nativeShape = population(); save(nativeShape, 'same-source-distinct-claims');
const labels = annotations();
labels.outputs.push(outputJudgment(collect(nativeShape, labels).inventory.outputs[0], [0, 1]));
const happy = collect(nativeShape, labels);
const pending = structuredClone(nativeShape);
pending.cases[0].trace.events.push({ kind: 'native.dispatch', attempt: 'unknown-edge', root: 'read-route', user: 'u1', workflow: 'capture' });
const unknown = collect(pending, labels);
const adjacentShape = population(); save(adjacentShape, 'switch-beta', 1);
const adjacentLabels = annotations();
adjacentLabels.outputs.push(outputJudgment(collect(adjacentShape, adjacentLabels).inventory.outputs[0]));
const adjacent = collect(adjacentShape, adjacentLabels);
assert.equal(absent.metrics.capture_admission_precision.status, 'not_run');
assert.equal(completeEmpty.metrics.capture_admission_precision.status, 'not_applicable');
assert.equal(happy.metrics.capture_admission_precision.value, 1);
assert.equal(happy.metrics.atomic_claim_coverage.numerator, 2);
assert.equal(happy.metrics.capture_opportunity_coverage.numerator, 1);
assert.equal(unknown.metrics.capture_admission_precision.status, 'blocked');
assert.equal(unknown.metrics.capture_admission_precision.denominator, null);
assert.equal(adjacent.metrics.capture_admission_precision.denominator, 1);
assert.equal(adjacent.metrics.capture_opportunity_coverage.numerator, 0);
assert.equal(happy.actual_quality.status, 'not_run');
const view = ({ status, numerator, denominator, value, missing }) => ({ status, numerator, denominator, value,
  missing_count: missing.length });
console.log(JSON.stringify({ kind: 'public_commonjs_offline_driver', synthetic: true, actual_quality: absent.actual_quality,
  no_run: view(absent.metrics.capture_admission_precision), complete_empty: view(completeEmpty.metrics.capture_admission_precision),
  happy: { precision: view(happy.metrics.capture_admission_precision), atomic: view(happy.metrics.atomic_claim_coverage),
    opportunity: view(happy.metrics.capture_opportunity_coverage) }, unknown_write: view(unknown.metrics.capture_admission_precision),
  adjacent_earlier_turn: { precision: view(adjacent.metrics.capture_admission_precision),
    opportunity: view(adjacent.metrics.capture_opportunity_coverage) }, accounting: { tokens: happy.accounting.tokens.input,
    cost: happy.accounting.cost, latency: happy.accounting.latency },
  frozen_counts: happy.freeze.planned, holdout: happy.freeze.holdout }, null, 2));
