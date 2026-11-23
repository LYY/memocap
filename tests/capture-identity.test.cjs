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

test('durable provenance changes preserve semantic identity while placement and conditions remain distinct', async () => {
  const { identify, sameKnowledge } = await load;
  const { units, citations } = require('./capture-body-fixture.cjs');
  const first = identify(units, placement, citations);
  const next = identify(units, placement, citations.map((citation) => ({ ...citation,
    source_id: 'another_source', pointer: { ...citation.pointer, locator: '/another/source', observed_at: 1800000000000 } })));

  const duplicate = sameKnowledge({ content: first.body, tags: first.tag, placement }, next);

  assert.equal(duplicate, true);
  assert.equal(first.fingerprint, next.fingerprint);
  assert.notEqual(first.body, next.body);
  assert.equal(sameKnowledge({ content: first.body, tags: first.tag, placement }, identify(units, 'universal', citations)), false);
  const changed = identify([{ text: units[0].text.replace('excludes live stylus', 'includes live stylus') }], placement, citations);
  assert.equal(sameKnowledge({ content: first.body, tags: changed.tag, placement }, changed), false);
});

test('message provenance without lines keeps UTF16 statement framing and CP excerpt spans', async () => {
  const { identify, sameKnowledge } = await load;
  const { citations } = require('./capture-body-fixture.cjs');
  const { createHash } = require('node:crypto');
  const units = [{ text: '😀 Alpha only.' }, { text: '中😀 Never beta.' }];
  const citation = { ...citations[0], content_hash: createHash('sha256').update('head😀 Alpha only. Never beta.').digest('hex'),
    span: { start: 4, end: 5 }, quote: '😀',
    pointer: { type: 'message_part', locator: 'synthetic_message/synthetic_part', observed_at: 1700000000000 } };

  const identity = identify(units, placement, [citation]);

  const footer = JSON.parse(identity.body.split('\n\nCapture sources: ')[1]);
  assert.deepEqual(footer.statements, [14, 15]);
  assert.deepEqual(footer.citations, [{ content_hash: citation.content_hash, span: [4, 5], excerpt: '😀', fragment: true,
    type: 'message_part', locator: citation.pointer.locator, observed_at: 1700000000000 }]);
  assert.equal(sameKnowledge({ content: identity.body, tags: identity.tag, placement }, identity), true);
});
