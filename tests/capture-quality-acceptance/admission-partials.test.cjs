const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { partialRun } = require('./admission-partials-fixture.cjs');
const { population, save, annotations, outputJudgment } = require('./examples.cjs');

test('independently bounded early partials enter admission without covering the compound gold', () => {
  const { result, labels, descriptor } = partialRun();

  const report = collect(result, labels, descriptor);

  for (const [name, numerator, denominator] of [['capture_admission_precision', 2, 2],
    ['capture_opportunity_coverage', 0, 1], ['atomic_claim_coverage', 0, 1],
    ['condition_retention', 3, 5], ['incorrect_support_rate', 0, 10]]) {
    assert.deepEqual([report.metrics[name].status, report.metrics[name].numerator, report.metrics[name].denominator],
      ['observed', numerator, denominator], name);
  }
  assert.equal(report.actual_quality.status, 'not_run');
  assert.equal(report.actual_quality.acceptance, null);
  assert.equal(report.freeze.gate, null);
});

test('legacy partial annotations without omission judgments still reject both saved records', () => {
  const { result, labels, descriptor } = partialRun();
  for (const label of labels.outputs) for (const condition of label.conditions) delete condition.admission_omission;

  const report = collect(result, labels, descriptor);

  assert.deepEqual([report.metrics.capture_admission_precision.status,
    report.metrics.capture_admission_precision.numerator, report.metrics.capture_admission_precision.denominator], ['observed', 0, 2]);
  assert.deepEqual([report.metrics.condition_retention.numerator, report.metrics.condition_retention.denominator], [3, 5]);
});

test('unknown admission omission does not hide known incomplete compound coverage', () => {
  const { result, labels, descriptor } = partialRun();
  for (const label of labels.outputs) label.conditions[3].admission_omission = {
    status: 'unknown',
    rationale: 'Only the admission exception is unsettled; the gold condition remains unpreserved.',
  };

  const report = collect(result, labels, descriptor);

  assert.deepEqual([report.metrics.capture_admission_precision.status,
    report.metrics.capture_admission_precision.numerator, report.metrics.capture_admission_precision.denominator], ['blocked', null, 2]);
  assert.deepEqual([report.metrics.capture_opportunity_coverage.status,
    report.metrics.capture_opportunity_coverage.numerator, report.metrics.capture_opportunity_coverage.denominator], ['observed', 0, 1]);
  assert.deepEqual([report.metrics.atomic_claim_coverage.status,
    report.metrics.atomic_claim_coverage.numerator, report.metrics.atomic_claim_coverage.denominator], ['observed', 0, 1]);
  assert.deepEqual([report.metrics.condition_retention.numerator, report.metrics.condition_retention.denominator], [3, 5]);
});

for (const omission of [null, [], {}, true, 'bounded_partial',
  { status: 'safe', rationale: 'Unrecognized label.' }, { status: 'bounded_partial' },
  { status: 'bounded_partial', rationale: ' ' }, { status: 'bounded_partial', rationale: 7 },
  { status: 'unknown', rationale: 'Not independently settled.' }]) {
  test(`unresolved omission ${JSON.stringify(omission)} blocks admission without dropping known denominators`, () => {
    const { result, labels, descriptor } = partialRun();
    for (const label of labels.outputs) label.conditions[3].admission_omission = omission;

    const report = collect(result, labels, descriptor);

    assert.deepEqual([report.metrics.capture_admission_precision.status,
      report.metrics.capture_admission_precision.numerator, report.metrics.capture_admission_precision.denominator], ['blocked', null, 2]);
    assert.deepEqual([report.metrics.capture_opportunity_coverage.status,
      report.metrics.capture_opportunity_coverage.numerator, report.metrics.capture_opportunity_coverage.denominator], ['observed', 0, 1]);
    assert.deepEqual([report.metrics.atomic_claim_coverage.status,
      report.metrics.atomic_claim_coverage.numerator, report.metrics.atomic_claim_coverage.denominator], ['observed', 0, 1]);
    assert.deepEqual([report.metrics.condition_retention.numerator, report.metrics.condition_retention.denominator], [3, 5]);
    assert.deepEqual([report.metrics.incorrect_support_rate.numerator, report.metrics.incorrect_support_rate.denominator], [0, 10]);
    assert.equal(report.inventory.outputs.length, 2);
  });
}

for (const index of [0, 1, 2]) for (const status of ['absent', 'invalidating']) {
  test(`original read-route condition ${index} remains necessary with ${status} omission judgment`, () => {
    const input = population(); save(input, 'read-route'); const labels = annotations();
    const label = outputJudgment(collect(input).inventory.outputs[0], [0]);
    label.conditions[index].preserved = false;
    if (status === 'invalidating') label.conditions[index].admission_omission = {
      status, rationale: 'This qualifier restricts the authorization or environment of the actual entry claim.',
    };
    labels.outputs.push(label);

    const report = collect(input, labels);

    assert.deepEqual([report.metrics.capture_admission_precision.status,
      report.metrics.capture_admission_precision.numerator, report.metrics.capture_admission_precision.denominator], ['observed', 0, 1]);
    assert.deepEqual([report.metrics.condition_retention.numerator, report.metrics.condition_retention.denominator], [2, 3]);
    assert.equal(report.metrics.capture_opportunity_coverage.numerator, 0);
  });
}

test('one invalidating omission prevents admission even with another valid partial exception', () => {
  const { result, labels, descriptor } = partialRun();
  for (const label of labels.outputs) label.conditions[3].admission_omission = {
    status: 'invalidating', rationale: 'The omitted condition is necessary to the asserted claim.',
  };

  const report = collect(result, labels, descriptor);

  assert.deepEqual([report.metrics.capture_admission_precision.numerator, report.metrics.capture_admission_precision.denominator], [0, 2]);
});

for (const defect of ['unsupported-fact', 'current-gap-attribution', 'invalid-context', 'ephemeral', 'case-rule']) {
  test(`bounded omissions cannot excuse ${defect}`, () => {
    const { result, labels, descriptor } = partialRun();
    for (const label of labels.outputs) {
      switch (defect) {
        case 'unsupported-fact': label.claims[0].support = 'unsupported'; break;
        case 'current-gap-attribution':
          label.claims[4].text = 'Current verification establishes the earlier entry and ordering.';
          label.claims[4].support = 'unsupported'; break;
        case 'invalid-context': label.context = 'invalid'; break;
        case 'ephemeral': label.durability = 'ephemeral'; break;
        case 'case-rule': label.case_rule.status = 'violated'; break;
        default: assert.fail(defect);
      }
    }

    const report = collect(result, labels, descriptor);

    assert.deepEqual([report.metrics.capture_admission_precision.status,
      report.metrics.capture_admission_precision.numerator, report.metrics.capture_admission_precision.denominator], ['observed', 0, 2]);
    assert.equal(report.metrics.capture_opportunity_coverage.numerator, 0);
  });
}

for (const defect of ['missing-output', 'duplicate-output', 'unattributed', 'incomplete-facts']) {
  test(`partial exceptions retain the ${defect} annotation rejection`, () => {
    const { result, labels, descriptor } = partialRun();
    switch (defect) {
      case 'missing-output': labels.outputs.pop(); break;
      case 'duplicate-output': labels.outputs.push(structuredClone(labels.outputs[0])); break;
      case 'unattributed': labels.adjudicators = []; break;
      case 'incomplete-facts': labels.outputs[0].segmentation_complete = false; break;
      default: assert.fail(defect);
    }

    const report = collect(result, labels, descriptor);

    assert.deepEqual([report.metrics.capture_admission_precision.status,
      report.metrics.capture_admission_precision.numerator, report.metrics.capture_admission_precision.denominator], ['blocked', null, 2]);
    assert.equal(report.inventory.outputs.length, 2);
  });
}

test('complementary partial conditions cannot jointly cover the compound gold', () => {
  const { result, labels, descriptor } = partialRun();
  for (const [index, label] of labels.outputs.entries()) {
    label.conditions[index + 3].preserved = true;
    delete label.conditions[index + 3].admission_omission;
    label.claims[0].gold_claim = 0;
  }

  const report = collect(result, labels, descriptor);

  assert.equal(report.metrics.capture_admission_precision.numerator, 2);
  assert.deepEqual([report.metrics.condition_retention.numerator, report.metrics.condition_retention.denominator], [5, 5]);
  assert.deepEqual([report.metrics.capture_opportunity_coverage.numerator, report.metrics.atomic_claim_coverage.numerator], [0, 0]);
});

test('fully preserved conditions need no omission exception to admit or cover', () => {
  const { result, labels, descriptor } = partialRun();
  for (const label of labels.outputs) {
    for (const condition of label.conditions) { condition.preserved = true; delete condition.admission_omission; }
    label.claims[0].gold_claim = 0;
  }

  const report = collect(result, labels, descriptor);

  assert.deepEqual([report.metrics.capture_admission_precision.numerator, report.metrics.capture_admission_precision.denominator], [2, 2]);
  assert.deepEqual([report.metrics.capture_opportunity_coverage.numerator, report.metrics.atomic_claim_coverage.numerator], [1, 1]);
});
