const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { population, save, hash } = require('./examples.cjs');

function actualCapture() {
  const input = population(); const item = save(input, 'read-route');
  const read = item.trace.events.find((event) => event.kind === 'native.readback');
  read.receipt = structuredClone(read.receipt);
  item.trace.saved_outputs[0].record.completeness = null;
  delete item.trace.saved_outputs[0].workflow;
  const dispatch = item.trace.events.find((event) => event.kind === 'native.dispatch');
  const commit = item.trace.events.find((event) => event.kind === 'native.commit');
  const record = commit.receipt.records[0];
  item.trace.events.push({ ...dispatch, kind: 'tool.output', receipt: { operation: 'remember',
    operation_id: commit.receipt.operation_id, status: 'inserted', error: null,
    returned_ids: [record.id], results: [{ memory: { id: record.id, placement: record.placement, content: record.content, tags: '' } }] } });
  return { input, item, read, dispatch, commit };
}

test('actual write mirrors fold once without promising full read completeness', () => {
  const { input } = actualCapture(); const before = JSON.stringify(input);
  const result = collect(input);
  assert.equal(result.inventory.attempts[0].verified, true);
  assert.equal(result.inventory.outputs.length, 1);
  assert.equal(result.inventory.outputs[0].sources.length, 4);
  assert.equal(result.inventory.outputs[0].record.completeness, null);
  assert.equal(JSON.stringify(input), before);
});

for (const variant of ['missing-read', 'partial-read', 'read-id', 'read-placement', 'read-content', 'read-tags', 'read-operation',
  'mirror-content', 'mirror-tags', 'mirror-operation', 'duplicate-source', 'missing-workflow']) {
  test(`actual write proof rejects ${variant}`, () => {
    const { input, item, read, commit } = actualCapture();
    if (variant === 'missing-read') item.trace.events = item.trace.events.filter((event) => event !== read);
    if (variant === 'partial-read') read.receipt.records[0].completeness = 'partial';
    if (variant === 'read-id') read.receipt.records[0].id = 99;
    if (variant === 'read-placement') read.receipt.records[0].placement = 'universal';
    if (variant === 'read-content') read.receipt.records[0].content = 'Tampered.';
    if (variant === 'read-tags') read.receipt.records[0].tags_hash = hash('foreign');
    if (variant === 'read-operation') read.receipt.operation_id = commit.receipt.operation_id;
    if (variant.startsWith('mirror-')) {
      item.trace.writes[0] = structuredClone(item.trace.writes[0]);
      const receipt = item.trace.writes[0].receipt;
      if (variant === 'mirror-content') receipt.records[0].content = 'Tampered.';
      if (variant === 'mirror-tags') receipt.records[0].tags_hash = hash('foreign');
      if (variant === 'mirror-operation') receipt.operation_id = 'foreign';
    }
    if (variant === 'duplicate-source') item.trace.saved_outputs.push(structuredClone(item.trace.saved_outputs[0]));
    if (variant === 'missing-workflow') delete commit.workflow;
    const result = collect(input);
    assert.equal(result.inventory.attempts[0].verified, false);
    assert.ok(result.inventory.outputs.every((row) => !row.verified));
    assert.equal(result.metrics.capture_admission_precision.status, 'blocked');
  });
}

test('parent memory read/use metadata remains events without creating reviews or writes', () => {
  const input = population(); const item = input.cases[0];
  const binding = { root: item.id, user: 'u1', session: 'parent', message: 'adopt' };
  item.trace.events.push({ ...binding, kind: 'memory.read' }, { ...binding, kind: 'memory.use' },
    { ...binding, kind: 'permission', tool: 'memocap_read', outcome: 'resolved' },
    { ...binding, kind: 'tool.output', tool: 'memocap_maintain', args: { operation: 'use' }, receipt: { status: 'used' } });
  const result = collect(input);
  assert.equal(result.inventory.events.length, 4);
  assert.equal(result.inventory.reviews.filter((row) => row.case_id === item.id).length, 1);
  assert.equal(result.inventory.cases[0].complete, true);
  assert.equal(result.inventory.attempts.length, 0);
});

for (const kind of ['raw', 'support', 'issued', 'native.dispatch', 'tool.output']) test(`missing workflow on critical ${kind} remains rejected`, () => {
  const input = population();
  input.cases[0].trace.events.push({ kind, root: 'read-route', user: 'u1', tool: 'memocap_remember', receipt: { status: 'inserted' } });
  const result = collect(input);
  assert.equal(result.inventory.cases[0].complete, false);
  assert.ok(result.inventory.reviews.some((row) => row.lane === 'unknown' && row.missing.includes('review:binding')));
});
