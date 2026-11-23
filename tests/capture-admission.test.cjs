const assert = require('node:assert/strict');
const test = require('node:test');

async function fixture(text = 'Please use Chinese for future responses.') {
  const api = await import('../plugin/capture/sources.js');
  const { admitCandidate } = await import('../plugin/capture/admission.js');
  const { captureSourceProfile } = await import('../plugin/capture/sources/profile.js');
  const source = api.adaptSource({ host_version: '1.19.3', user_id: 'user', observed_at: 1,
    message: { id: 'user', role: 'user' }, part: { id: 'preference', messageID: 'user', type: 'text', text } }).source;
  const host = { sources: new Map([[source.source_id, source]]), bundles: api.sourceBundles([source], captureSourceProfile).bundles, userID: 'user' };
  const citation = { source_id: source.source_id, content_hash: source.content_hash, span: source.span, quote: source.text };
  const proposal = { candidates: [{ statements: [{ text: 'The user prefers Chinese responses.', citations: [citation] }] }] };
  return { admitCandidate, host, proposal, citation };
}

test('preserves a synthesized preference with exact provenance and immutable inputs', async () => {
  const current = await fixture();
  Object.freeze(current.proposal.candidates[0].statements[0]);
  const result = current.admitCandidate(current.proposal, current.host);
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.statements[0].text, 'The user prefers Chinese responses.');
  assert.equal(Object.isFrozen(result.candidate.statements[0]), true);
});

for (const field of ['database', 'repository', 'repository_id', 'domain', 'universal', 'force', 'topic', 'placement', 'body']) {
  test(`model cannot supply ${field}`, async () => {
    const current = await fixture();
    current.proposal.candidates[0][field] = 'model-selected';
    assert.equal(current.admitCandidate(current.proposal, current.host).reason.code, 'invalid_proposal');
  });
}

for (const secret of ['password = "example-sensitive-value"', 'Authorization: Bearer abcdefghijklmnop',
  '-----BEGIN PRIVATE KEY-----\nabcdef', 'https://operator:secret@example.invalid/entry',
  'Store credential <EXAMPLE_VALUE> for later.', 'api_key: abcdefghijklmnopqrstuvwxyz',
  'The password is synthetic-sensitive-value.', 'https://example.invalid/docs?access_token=example-sensitive-value', '凭据：示例机密值']) {
  test('rejects credential-shaped model output without returning payload', async () => {
    const current = await fixture();
    current.proposal.candidates[0].statements[0].text = secret;
    assert.deepEqual(current.admitCandidate(current.proposal, current.host), { status: 'skip', reason: { code: 'secret' } });
  });
}

for (const proposal of [null, [], 'text', {}, { candidates: [null] }, { candidates: [{ statements: [null] }] }]) {
  test('rejects malformed parsed proposals without throwing or echoing input', async () => {
    const current = await fixture();
    assert.equal(current.admitCandidate(proposal, current.host).reason.code, 'invalid_proposal');
  });
}

test('rejects aggregate quotation overflow rather than clipping conditions', async () => {
  const current = await fixture('A'.repeat(801));
  assert.equal(current.admitCandidate(current.proposal, current.host).reason.code, 'quote_budget');
});

test('counts Unicode codepoints for exact spans', async () => {
  const current = await fixture('A😀中');
  assert.equal(current.citation.span.end, 3);
  assert.equal(current.admitCandidate(current.proposal, current.host).status, 'candidate');
});
