const assert = require('node:assert/strict');
const test = require('node:test');
const load = import('../plugin/capture/identity.js');
const placement = `repository:${'a'.repeat(64)}`;

test('same complete knowledge in distinct turns has one identity while original Source lines survive', async () => {
  const { identify, sameKnowledge } = await load;
  const text = 'I prefer Chinese.\nSource: user-authored reference';
  const first = identify([{ text, pointer: 'message:u1/p1' }], placement);
  const second = identify([{ text, pointer: 'message:u2/p2' }], placement);
  assert.equal(first.tag, second.tag);
  assert.notEqual(first.body, second.body);
  assert.ok(first.body.startsWith(text));
  assert.equal(sameKnowledge({ content: first.body, tags: first.tag, placement }, second), true);
});

test('identity sorts and deduplicates substantive complete units and normalizes only line endings and outer whitespace', async () => {
  const { identify } = await load;
  const first = identify([{ text: ' A\r\nB ', pointer: 'message:u1/p' }, { text: 'C', pointer: 'message:u1/q' }], placement);
  const second = identify([{ text: 'C', pointer: 'tool:a2/c' }, { text: 'A\nB', pointer: 'message:u2/p' }, { text: 'C', pointer: 'message:u2/q' }], placement);
  assert.equal(first.tag, second.tag);
  assert.notEqual(first.tag, identify([{ text: 'A B', pointer: 'message:u/p' }, { text: 'C', pointer: 'message:u/q' }], placement).tag);
});

test('different placement or necessary condition is not an exact knowledge duplicate', async () => {
  const { identify, sameKnowledge } = await load;
  const unit = { text: 'Alpha only. No beta.', pointer: 'tool:a/c' };
  const first = identify([unit], placement);
  const other = identify([unit], 'universal');
  const changed = identify([{ ...unit, text: 'Alpha and beta.' }], placement);
  assert.notEqual(first.tag, other.tag);
  assert.notEqual(first.tag, changed.tag);
  assert.equal(sameKnowledge({ content: first.body, tags: first.tag, placement: 'universal' }, first), false);
  assert.equal(sameKnowledge({ content: changed.body, tags: first.tag, placement }, first), false);
});

test('a copied fingerprint tag cannot certify unrelated raw knowledge or untagged text', async () => {
  const { identify, sameKnowledge } = await load;
  const candidate = identify([{ text: 'Use Chinese.', pointer: 'message:u/p' }], placement);
  assert.equal(sameKnowledge({ content: 'Unrelated.', tags: candidate.tag, placement }, candidate), false);
  assert.equal(sameKnowledge({ content: candidate.body, tags: '', placement }, candidate), false);
});
