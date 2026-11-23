const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { population, save, annotations, outputJudgment, hash } = require('./examples.cjs');

function labeled(input) {
  const labels = annotations();
  labels.outputs = collect(input).inventory.outputs.map((row) => outputJudgment(row, [0, 1]));
  return labels;
}

for (const source of ['saved_outputs', 'writes']) test(`B2 blocks an uncommitted record in ${source}`, () => {
  const input = population(); const item = save(input, 'same-source-distinct-claims');
  const record = { ...item.trace.saved_outputs[0].record, id: 999, content: 'Foreign uncommitted body.' };
  record.content_hash = hash(record.content);
  if (source === 'saved_outputs') item.trace.saved_outputs.push({ ...item.trace.saved_outputs[0], record });
  else item.trace.writes[0].receipt = { ...item.trace.writes[0].receipt, records: [item.trace.saved_outputs[0].record, record] };

  const result = collect(input, labeled(input));

  assert.equal(result.inventory.outputs.find((row) => row.record.id === 999)?.verified, false);
  assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
  assert.equal(result.metrics.capture_admission_precision.value, null);
});

test('B2 keeps a same-source repeated output inspectable and blocks credit', () => {
  const input = population(); const item = save(input, 'same-source-distinct-claims');
  item.trace.saved_outputs.push(structuredClone(item.trace.saved_outputs[0]));

  const result = collect(input, labeled(input));

  assert.equal(result.inventory.outputs.length, 2);
  assert.equal(new Set(result.inventory.outputs.map((row) => row.key)).size, 2);
  assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
});

test('B2 cross-view saved, commit and write mirrors remain one actual save', () => {
  const input = population(); save(input, 'same-source-distinct-claims');

  const result = collect(input, labeled(input));

  assert.equal(result.inventory.outputs.length, 1);
  assert.equal(result.metrics.capture_admission_precision.denominator, 1);
  assert.equal(result.metrics.atomic_claim_coverage.numerator, 2);
});

for (const field of ['content', 'content_hash', 'tags_hash', 'placement']) test(`B2 joins the output's exact ${field}`, () => {
  const input = population(); const item = save(input, 'same-source-distinct-claims');
  item.trace.saved_outputs[0].record = { ...item.trace.saved_outputs[0].record, [field]: 'foreign' };

  const result = collect(input, labeled(input));

  assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
  assert.equal(result.inventory.outputs.some((row) => !row.verified), true);
});

test('B3 rejects a consistently substituted capture read tool', () => {
  const input = population(); const item = save(input, 'same-source-distinct-claims');
  for (const event of item.trace.events) if (event.tool) event.tool = 'memocap_recall';

  const result = collect(input, labeled(input));

  assert.equal(result.inventory.attempts[0].verified, false);
  assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
});

for (const operation of ['foreign-operation', 'matching']) test(`B3 binds every tool output operation: ${operation}`, () => {
  const input = population(); const item = save(input, 'same-source-distinct-claims');
  const dispatch = item.trace.events.find((event) => event.kind === 'native.dispatch');
  const commit = item.trace.events.find((event) => event.kind === 'native.commit');
  const record = item.trace.saved_outputs[0].record;
  item.trace.events.push({ ...dispatch, kind: 'tool.output', receipt: { operation: 'remember', status: 'inserted',
    operation_id: operation === 'matching' ? commit.receipt.operation_id : operation,
    returned_ids: [record.id], results: [{ completeness: 'full', memory: { ...record, tags: '' } }] } });

  const result = collect(input, labeled(input));

  assert.equal(result.metrics.capture_admission_precision.status, operation === 'matching' ? 'observed' : 'blocked');
  assert.equal(result.inventory.outputs.length, operation === 'matching' ? 1 : 2);
});

for (const [field, malformed] of [['claims', {}], ['claims', [null]], ['conditions', [null]]]) {
  test(`C1 reports malformed ${field} ${JSON.stringify(malformed)} without losing inventory`, () => {
    const input = population(); save(input, 'same-source-distinct-claims'); const labels = labeled(input);
    labels.outputs[0][field] = malformed; const before = JSON.stringify([input, labels]);

    const result = collect(input, labels);

    assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
    assert.equal(result.metrics.capture_admission_precision.value, null);
    assert.equal(result.inventory.outputs.length, 1);
    assert.ok(result.annotations.issues.length);
    assert.equal(JSON.stringify([input, labels]), before);
  });
}

for (const malformed of [null, [], { adjudicators: {} }, { adjudicators: [null] }]) test(`C1 parses annotation envelope ${JSON.stringify(malformed)}`, () => {
  const input = population(); save(input, 'same-source-distinct-claims');

  const result = collect(input, malformed);

  assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
  assert.equal(result.inventory.outputs.length, 1);
});
