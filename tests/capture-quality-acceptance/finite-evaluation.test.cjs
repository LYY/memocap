const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { population: examples, annotations, save, outputJudgment } = require('./examples.cjs');
const { population, createEvaluation } = require('../capture-quality-population-native/population.cjs');
const { toy, digest } = require('../capture-quality-population-native/evaluation-fixture.cjs');
const { hash } = require('./definitions.cjs');

function selectedRun() {
  const input = toy(); const raw = JSON.parse(input.input_utf8);
  raw.capture[0].family = 'toy-route';
  raw.capture[0].gold = { action: 'save', claims: ['Toy claim'], conditions: ['Toy condition'], forbidden: 'case-only-rule' };
  raw.maintenance[0].family = 'toy-maintenance'; raw.maintenance[0].gold = { action: 'update', mutations: 1 };
  input.input_utf8 = JSON.stringify(raw); input.input_sha256 = digest(input.input_utf8);
  input.mapping.tuning_sha256 = input.input_sha256; input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  const descriptor = createEvaluation(input); const selected = population(descriptor);
  const result = examples(); const template = structuredClone(result.cases[0]);
  result.cases = selected.mapping.cases.map(({ id }) => {
    const row = structuredClone(template); const { original } = selected.resolveCase(id);
    row.id = id; row.original_sha256 = hash(original); row.tuning_sha256 = descriptor.input_sha256;
    for (const turn of row.turns) for (const review of turn.result.reviews) { review.parentID = id; review.workflow = selected.resolveCase(id).entry.pointer.split('/')[1]; }
    return row;
  });
  result.planned_case_ids = result.completed_case_ids = result.attempted_case_ids = result.cases.map(({ id }) => id);
  result.evaluation = { id: descriptor.id, input_sha256: descriptor.input_sha256,
    mapping_sha256: descriptor.mapping_sha256, evaluation_sha256: hash(descriptor) };
  return { descriptor, result };
}

test('selected finite cohort supplies its own definitions groups case rules and denominators', () => {
  const { descriptor, result } = selectedRun(); save(result, 'toy-read');
  const labels = annotations(); const row = collect(result, labels, descriptor).inventory.outputs[0];
  labels.outputs = [outputJudgment(row, [0])];
  const measured = collect(result, labels, descriptor);
  assert.deepEqual(measured.inventory.cases.map(({ id }) => id), ['toy-read', 'toy-update']);
  assert.deepEqual(measured.freeze.planned, { capture_cases: 1, maintenance_cases: 1,
    capture_opportunities: 1, capture_claims: 1, authorized_maintenance: 1 });
  assert.equal(measured.metrics.capture_opportunity_coverage.denominator, 1);
  assert.equal(measured.metrics.capture_admission_precision.status, 'blocked');
  assert.equal(measured.inventory.outputs[0].required_case_rule, 'case-only-rule');
  assert.deepEqual(measured.groups.map(({ family }) => family).sort(), ['toy-maintenance', 'toy-route']);
  assert.equal(measured.identity.distinct_claims, null);
});

for (const field of ['id', 'input_sha256', 'mapping_sha256', 'evaluation_sha256']) test(`refuses mismatched result ${field}`, () => {
  const { descriptor, result } = selectedRun(); result.evaluation[field] = 'foreign';
  assert.throws(() => collect(result, {}, descriptor), { code: 'evaluation_result_identity' });
});
test('explicit result cannot silently join default cohort without descriptor', () => {
  const { result } = selectedRun();
  assert.throws(() => collect(result), { code: 'evaluation_result_identity' });
});
test('input gold mutation with stale digest is refused by the actual finite compiler', () => {
  const { descriptor, result } = selectedRun(); const changed = structuredClone(descriptor);
  changed.input_utf8 = changed.input_utf8.replace('Toy claim', 'Other claim');
  assert.throws(() => collect(result, {}, changed), { code: 'evaluation_digest_mismatch' });
});
test('recompiled descriptor discards substituted closures and refuses cross-cohort labels', () => {
  const { descriptor, result } = selectedRun(); const selected = population(descriptor);
  const labels = annotations(); labels.outputs = [{ key: 'foreign-cohort', ...annotations() }];
  const measured = collect(result, labels, { ...selected, resolveCase() { throw new Error('substituted'); } });
  assert.equal(measured.inventory.cases.length, 2);
  assert.equal(measured.metrics.capture_admission_precision.status, 'blocked');
});
test('unscored finite input has unknown eligibility denominators rather than invented zero', () => {
  const { result } = selectedRun(); const descriptor = createEvaluation(toy()); const selected = population(descriptor);
  result.evaluation = { id: descriptor.id, input_sha256: descriptor.input_sha256,
    mapping_sha256: descriptor.mapping_sha256, evaluation_sha256: hash(descriptor) };
  for (const row of result.cases) { row.original_sha256 = hash(selected.resolveCase(row.id).original); row.tuning_sha256 = descriptor.input_sha256; }
  const measured = collect(result, annotations(), descriptor);
  assert.equal(measured.metrics.capture_opportunity_coverage.denominator, null);
  assert.equal(measured.metrics.missed_maintenance.denominator, null);
  assert.equal(measured.metrics.capture_opportunity_coverage.status, 'blocked');
});
test('default tuning remains 28 cases 32 turns 8 opportunities 9 claims and 2 maintenance positives', () => {
  const measured = collect(examples(), annotations());
  assert.equal(measured.inventory.cases.length, 28);
  assert.equal(measured.inventory.cases.reduce((sum, row) => sum + row.turns, 0), 32);
  assert.deepEqual(measured.freeze.planned, { capture_cases: 16, maintenance_cases: 12,
    capture_opportunities: 8, capture_claims: 9, authorized_maintenance: 2 });
});
test('unscored finite descriptor keeps null planned eligibility before any run', () => {
  const report = collect(null, {}, createEvaluation(toy()));
  assert.equal(report.freeze.planned.capture_opportunities, null);
  assert.equal(report.freeze.planned.capture_claims, null);
  assert.equal(report.freeze.planned.authorized_maintenance, null);
});
test('finite maintenance action without mutation eligibility stays unknown before a run', () => {
  const input = toy(); const raw = JSON.parse(input.input_utf8);
  raw.maintenance[0].gold = { action: 'update' };
  input.input_utf8 = JSON.stringify(raw); input.input_sha256 = digest(input.input_utf8);
  input.mapping.tuning_sha256 = input.input_sha256; input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  const report = collect(null, {}, createEvaluation(input));
  assert.equal(report.freeze.planned.authorized_maintenance, null);
  assert.equal(report.inventory.cases.find(({ id }) => id === 'toy-update').eligibility_known, false);
  assert.equal(report.metrics.missed_maintenance.denominator, null);
});
