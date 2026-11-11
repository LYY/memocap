const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { receipt, memory } = require('./plugin-fixture.cjs');

const hash = (content) => createHash('sha256').update(content, 'utf8').digest('hex');

test('partial references preserve Unicode boundaries, body hash, metadata and an exact full read route', async () => {
  const { referenceBlock } = await import('../plugin/protocol.js');
  const content = `${'😀"\\\n'.repeat(3000)}最后禁止删除`;
  const row = memory(21, content);
  row.memory.topic_key = 'tail-prohibition';
  const envelope = receipt('recall', { results: [row], returned_ids: [21], discovery: { kind: 'library' },
    query_terms: ['尾部'], searched_placements: [row.memory.placement], truncated: false });
  const block = referenceBlock(envelope, {});
  const payload = JSON.parse(block.text.slice(block.text.indexOf('\n') + 1));
  const reference = payload.references[0];
  assert.ok(block.text.length <= 6000);
  assert.equal(reference.completeness, 'partial');
  assert.equal(reference.content_hash, hash(content));
  assert.equal(reference.content.isWellFormed(), true);
  assert.equal(content.startsWith(reference.content), true);
  assert.equal(reference.memory_metadata.topic_key, 'tail-prohibition');
  assert.deepEqual(reference.read, { tool: 'memocap_read', arguments: { id: 21, placement: row.memory.placement, content_hash: hash(content) } });
  assert.deepEqual(payload.query_terms, ['尾部']);
  assert.deepEqual(payload.searched_placements, [row.memory.placement]);
  assert.equal(payload.truncated, true);
});

test('full references hash the complete UTF8 body and preserve source applicability independently', async () => {
  const { referenceBlock } = await import('../plugin/protocol.js');
  const row = memory(22, 'café 😀');
  row.visibility = 'source';
  row.applicable_repositories = [];
  const block = referenceBlock(receipt('recall', { results: [row], returned_ids: [22] }), {});
  const reference = JSON.parse(block.text.slice(block.text.indexOf('\n') + 1)).references[0];
  assert.equal(reference.completeness, 'full');
  assert.equal(reference.content_hash, hash('café 😀'));
  assert.equal(reference.visibility, 'source');
  assert.deepEqual(reference.applicable_repositories, []);
});

test('an exact read checks the requested placement and independently verifies a provided body hash', async () => {
  const { validateRead } = await import('../plugin/protocol.js');
  const row = memory(23, 'current full body');
  const full = receipt('read', { results: [row], returned_ids: [23] });
  const result = validateRead(full, { id: 23, placement: row.memory.placement, content_hash: hash('older body') });
  assert.equal(result.record_changed, true);
  assert.equal(result.results[0].content_hash, hash('current full body'));
  assert.equal(result.results[0].completeness, 'full');
  assert.throws(() => validateRead(full, { id: 23, placement: 'universal' }), { code: 'invalid_receipt' });
  assert.throws(() => validateRead(receipt('read', { results: [{ ...row, content_hash: hash('forged') }], returned_ids: [23] }),
    { id: 23, placement: row.memory.placement }), { code: 'invalid_receipt' });
});

test('recall rejects a source receipt with a forged full-body digest or a different selector', async () => {
  const { validateMemories } = await import('../plugin/protocol.js');
  const row = memory(24, 'whole body');
  row.content_hash = hash('different body');
  assert.throws(() => validateMemories(receipt('recall', { results: [row], returned_ids: [24] })), { code: 'invalid_receipt' });
  assert.throws(() => validateMemories(receipt('recall'), { kind: 'origins', placements: ['universal'] }), { code: 'invalid_receipt' });
});
