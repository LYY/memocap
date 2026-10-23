const assert = require('node:assert/strict');
const test = require('node:test');
const { receipt, memory } = require('./plugin-fixture.cjs');

test('receipt boundary rejects unknown states and noncanonical operation identities', async () => {
  const { validateReceipt } = await import('../plugin/protocol.js');
  for (const overrides of [{ status: 'unrecognized' }, { activity_status: 'unrecognized' }, { operation_id: 'op-draft' }]) {
    assert.throws(() => validateReceipt(receipt('recall', overrides)), { code: 'invalid_receipt' });
  }
});

test('reference budget includes provenance even when memory content is empty', async () => {
  const { referenceBlock } = await import('../plugin/protocol.js');
  const entry = memory(7, '');
  entry.applicable_repositories = [`repository:${'a'.repeat(9000)}`];
  const prepared = referenceBlock(receipt('recall', { results: [entry], returned_ids: [7] }), {});
  assert.ok(prepared.text.length <= 6000);
  assert.deepEqual(prepared.injected_ids, []);
});

test('shadowed inventory rows remain addressable but cannot be injected as recalled memories', async () => {
  const { validateMemories, validateInventory } = await import('../plugin/protocol.js');
  const entry = memory(3);
  entry.visibility = 'shadowed';
  const inventory = receipt('list', { results: [entry], returned_ids: [3] });
  assert.equal(validateInventory(inventory), inventory);
  assert.throws(() => validateMemories(inventory), { code: 'invalid_receipt' });
  entry.visibility = 'unknown';
  assert.throws(() => validateInventory(inventory), { code: 'invalid_receipt' });
});
