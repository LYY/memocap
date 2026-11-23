const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { population, save, annotations, outputJudgment, hash } = require('./examples.cjs');
const fullRunbook = '# Alpha release\nApproval required. Never use for beta.\n1. Start at scripts/alpha-release.\n2. Verify mock://quartz/health before finishing.';

function runbook(content = fullRunbook) {
  const input = population(); const saved = save(input, 'runbook-short-route');
  const record = saved.trace.saved_outputs[0].record;
  record.content = content; record.content_hash = hash(content);
  const labels = annotations(); const inventory = collect(input).inventory;
  const label = outputJudgment(inventory.outputs[0], [0]);
  label.claims[0].text = inventory.cases.find((row) => row.id === saved.id).gold.claims[0];
  labels.outputs.push(label);
  return { input, labels };
}

test('complete supported runbook violates independent whole-memory admission', () => {
  const { input, labels } = runbook();
  labels.outputs[0].case_rule = { status: 'violated', rationale: 'The complete numbered runbook is persisted.' };

  const result = collect(input, labels);

  assert.equal(result.inventory.outputs[0].verified, true);
  assert.deepEqual(result.inventory.outputs[0].judgment_missing, []);
  assert.deepEqual([result.metrics.capture_admission_precision.numerator, result.metrics.capture_admission_precision.denominator], [0, 1]);
  assert.deepEqual([result.metrics.capture_opportunity_coverage.numerator, result.metrics.capture_opportunity_coverage.denominator], [0, 8]);
  assert.deepEqual([result.metrics.atomic_claim_coverage.numerator, result.metrics.atomic_claim_coverage.denominator], [0, 9]);
  assert.deepEqual([result.metrics.incorrect_support_rate.numerator, result.metrics.incorrect_support_rate.denominator], [0, 1]);
  assert.deepEqual([result.metrics.condition_retention.numerator, result.metrics.condition_retention.denominator], [4, 4]);
  assert.equal(result.actual_quality.status, 'not_run');
});

test('concise qualified runbook route satisfies its independent case rule', () => {
  const { input, labels } = runbook('Alpha release: approval required; never beta. Entry: scripts/alpha-release; verify mock://quartz/health.');
  labels.outputs[0].case_rule = { status: 'satisfied', rationale: 'A qualified entry route is saved without the numbered procedure.' };

  const result = collect(input, labels);

  assert.equal(result.metrics.capture_admission_precision.value, 1);
  assert.equal(result.metrics.capture_opportunity_coverage.numerator, 1);
  assert.equal(result.metrics.atomic_claim_coverage.numerator, 1);
});

for (const verdict of [undefined, null, [], {}, 'satisfied', true,
  { status: 'passed', rationale: 'Unknown verdict.' }, { status: 'satisfied' }, { status: 'satisfied', rationale: ' ' }]) {
  test(`applicable case rule fails closed for ${JSON.stringify(verdict)}`, () => {
    const { input, labels } = runbook();
    if (verdict !== undefined) labels.outputs[0].case_rule = verdict;

    const result = collect(input, labels);

    for (const [name, denominator] of [['capture_admission_precision', 1], ['capture_opportunity_coverage', 8], ['atomic_claim_coverage', 9]]) {
      assert.equal(result.metrics[name].status, 'blocked');
      assert.equal(result.metrics[name].numerator, null);
      assert.equal(result.metrics[name].adjudicated_numerator, 0);
      assert.equal(result.metrics[name].denominator, denominator);
      assert.ok(result.metrics[name].missing.length);
    }
    assert.equal(result.metrics.incorrect_support_rate.denominator, 1);
    assert.equal(result.metrics.incorrect_support_rate.numerator, 0);
    assert.equal(result.metrics.condition_retention.numerator, 4);
  });
}

test('explicit unknown case-rule judgment remains distinct from missing judgment', () => {
  const { input, labels } = runbook();
  labels.outputs[0].case_rule = { status: 'unknown', rationale: 'Whole-memory eligibility is not established.' };

  const result = collect(input, labels);

  assert.deepEqual(result.inventory.outputs[0].case_rule_missing, []);
  assert.equal(result.inventory.outputs[0].case_rule_judgment.status, 'unknown');
  assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
  assert.equal(result.metrics.capture_opportunity_coverage.adjudicated_numerator, 0);
  assert.equal(result.metrics.atomic_claim_coverage.adjudicated_numerator, 0);
  assert.equal(result.metrics.incorrect_support_rate.value, 0);
});

test('independent case-rule verdict changes only admission and coverage metrics', () => {
  const { input, labels } = runbook();
  const satisfied = structuredClone(labels);
  satisfied.outputs[0].case_rule = { status: 'satisfied', rationale: 'Independent eligibility judgment.' };
  labels.outputs[0].case_rule = { status: 'violated', rationale: 'Independent ineligibility judgment.' };
  const expected = collect(input, satisfied);

  const result = collect(input, labels);

  for (const name of Object.keys(expected.metrics).filter((name) => !['capture_admission_precision', 'capture_opportunity_coverage', 'atomic_claim_coverage'].includes(name))) {
    assert.deepEqual(result.metrics[name], expected.metrics[name]);
  }
  assert.equal(result.metrics.capture_admission_precision.numerator, 0);
});

for (const id of ['read-route', 'verified-api-route']) test(`non-applicable ${id} needs no case-rule label`, () => {
  const input = population(); const saved = save(input, id); const labels = annotations();
  const record = saved.trace.saved_outputs[0].record;
  record.content = collect(input).inventory.cases.find((row) => row.id === id).gold.claims[0];
  record.content_hash = hash(record.content);
  labels.outputs = collect(input).inventory.outputs.map((row) => outputJudgment(row, [0]));

  const result = collect(input, labels);

  assert.equal(result.metrics.capture_admission_precision.value, 1);
  assert.equal(result.metrics.capture_opportunity_coverage.numerator, 1);
  assert.equal(result.metrics.atomic_claim_coverage.numerator, 1);
});
