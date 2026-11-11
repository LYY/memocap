const assert = require('node:assert/strict');
const test = require('node:test');

const admission = import('../plugin/capture/admission.js');

function fixture(text = 'Please use Chinese for my future responses.') {
  return {
    proposal: { candidates: [{ evidence: [{ sourceId: 'unit-1', quote: text }] }] },
    host: {
      evidence: new Map([['unit-1', {
        source: 'user', text, pointer: 'message:user-1', eligibility: 'durable',
      }]]),
      limits: { maxEvidenceUnits: 3, maxQuoteCodePoints: 400, maxBodyCodePoints: 600 },
      existingBodies: [],
    },
  };
}

async function evaluate(current) {
  return (await admission).admitCandidate(current.proposal, current.host);
}

test('preserves a long-term user preference with factual provenance', async () => {
  const current = fixture();
  const result = await evaluate(current);
  assert.deepEqual(result, { status: 'candidate', candidate: {
    body: 'Please use Chinese for my future responses.\nSource: message:user-1',
    sources: [{ sourceId: 'unit-1', pointer: 'message:user-1' }],
  } });
});

test('admits a concise documented route without provider or repository defaults', async () => {
  const current = fixture('For lunar alpha releases, start at /workspace/lunar docs/alpha.md. Approval required. No beta mapping verified.');
  Object.assign(current.host.evidence.get('unit-1'), {
    source: 'tool', success: true, pointer: 'file:/workspace/lunar/docs/alpha.md#entry',
  });
  current.proposal.candidates[0].kind = 'runbook';
  const result = await evaluate(current);
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.kind, 'runbook');
  assert.equal(result.candidate.body, 'For lunar alpha releases, start at /workspace/lunar docs/alpha.md. Approval required. No beta mapping verified.\nSource: file:/workspace/lunar/docs/alpha.md#entry');
});

test('rejects a prefix quote that drops trailing alpha conditions', async () => {
  const current = fixture('Alpha uses /workspace/lunar. No beta mapping verified.');
  current.proposal.candidates[0].evidence[0].quote = 'Alpha uses /workspace/lunar.';
  assert.deepEqual(await evaluate(current), { status: 'skip', reason: { code: 'evidence_mismatch' } });
});

for (const [name, change, code] of [
  ['missing source', (current) => current.host.evidence.clear(), 'missing_evidence'],
  ['mismatched quote', (current) => { current.proposal.candidates[0].evidence[0].quote = 'Beta uses alpha entry.'; }, 'evidence_mismatch'],
  ['assistant claim', (current) => { current.host.evidence.get('unit-1').source = 'assistant'; }, 'unsupported_source'],
  ['unknown source', (current) => { current.host.evidence.get('unit-1').source = 'recall'; }, 'unsupported_source'],
  ['failed tool', (current) => Object.assign(current.host.evidence.get('unit-1'), { source: 'tool', success: false }), 'unsupported_source'],
  ['unconfirmed tool', (current) => { current.host.evidence.get('unit-1').source = 'tool'; }, 'unsupported_source'],
  ['ephemeral state', (current) => { current.host.evidence.get('unit-1').eligibility = 'ephemeral'; }, 'no_durable_value'],
  ['unsupported guess', (current) => { current.host.evidence.get('unit-1').eligibility = 'unsupported'; }, 'insufficient_evidence'],
  ['full runbook', (current) => { current.host.evidence.get('unit-1').eligibility = 'runbook'; }, 'runbook_copy'],
  ['unreviewed evidence', (current) => { delete current.host.evidence.get('unit-1').eligibility; }, 'insufficient_evidence'],
  ['multiple candidates', (current) => current.proposal.candidates.push(current.proposal.candidates[0]), 'multiple_candidates'],
  ['no candidates', (current) => { current.proposal.candidates = []; }, 'no_candidate'],
  ['no quotes', (current) => { current.proposal.candidates[0].evidence = []; }, 'invalid_proposal'],
  ['repeated source', (current) => current.proposal.candidates[0].evidence.push(current.proposal.candidates[0].evidence[0]), 'duplicate_evidence'],
  ['quote budget', (current) => { current.host.limits.maxQuoteCodePoints = 3; }, 'quote_budget'],
  ['body budget', (current) => { current.host.limits.maxBodyCodePoints = 3; }, 'body_budget'],
  ['missing limits', (current) => { delete current.host.limits; }, 'invalid_host_input'],
  ['noninteger budget', (current) => { current.host.limits.maxBodyCodePoints = 1.5; }, 'invalid_host_input'],
  ['unknown kind', (current) => { current.proposal.candidates[0].kind = 'fact'; }, 'invalid_proposal'],
  ['unknown quote field', (current) => { current.proposal.candidates[0].evidence[0].offset = 0; }, 'invalid_proposal'],
  ['unknown envelope field', (current) => { current.proposal.extra = true; }, 'invalid_proposal'],
]) {
  test(`rejects ${name}`, async () => {
    const current = fixture();
    change(current);
    assert.deepEqual(await evaluate(current), { status: 'skip', reason: { code } });
  });
}

for (const field of ['database', 'repository', 'repository_id', 'domain', 'universal', 'force', 'topic', 'placement', 'body']) {
  test(`model cannot supply ${field}`, async () => {
    const current = fixture();
    current.proposal.candidates[0][field] = 'model-selected';
    assert.deepEqual(await evaluate(current), { status: 'skip', reason: { code: 'invalid_proposal' } });
  });
}

for (const secret of [
  'password = "example-sensitive-value"',
  'Authorization: Bearer abcdefghijklmnop',
  '-----BEGIN PRIVATE KEY-----\nabcdef',
  'https://operator:secret@example.invalid/entry',
  'Store credential <EXAMPLE_VALUE> for later.',
  'api_key: abcdefghijklmnopqrstuvwxyz',
  'The password is synthetic-sensitive-value.',
  'https://example.invalid/docs?access_token=example-sensitive-value',
  '凭据：示例机密值',
]) {
  test('rejects credential-shaped evidence without returning the payload', async () => {
    const current = fixture(secret);
    assert.deepEqual(await evaluate(current), { status: 'skip', reason: { code: 'secret' } });
  });
}

test('rejects secrets in host pointers even when selected quote is harmless', async () => {
  const current = fixture();
  current.host.evidence.get('unit-1').pointer = 'https://user:password@example.invalid/docs';
  assert.deepEqual(await evaluate(current), { status: 'skip', reason: { code: 'secret' } });
});

test('rejects an exact canonical duplicate body', async () => {
  const current = fixture('Alpha entry requires approval.');
  current.host.existingBodies = ['  Alpha entry requires approval.\r\nSource: message:user-1\n'];
  assert.deepEqual(await evaluate(current), { status: 'skip', reason: { code: 'duplicate_body' } });
});

test('does not claim semantic duplicate detection', async () => {
  const current = fixture('Alpha entry requires approval.');
  current.host.existingBodies = ['Get approval before using the alpha entry.'];
  assert.equal((await evaluate(current)).status, 'candidate');
});

test('enforces aggregate quotes and evidence count', async () => {
  const current = fixture('One.');
  current.host.evidence.set('unit-2', { source: 'user', text: 'Two.', pointer: 'message:user-2', eligibility: 'durable' });
  current.proposal.candidates[0].evidence.push({ sourceId: 'unit-2', quote: 'Two.' });
  current.host.limits.maxQuoteCodePoints = 7;
  assert.deepEqual(await evaluate(current), { status: 'skip', reason: { code: 'quote_budget' } });
});

test('rejects too many evidence units', async () => {
  const current = fixture();
  current.host.limits.maxEvidenceUnits = 0;
  assert.deepEqual(await evaluate(current), { status: 'skip', reason: { code: 'evidence_budget' } });
});

test('counts Unicode code points without clipping a supplementary character', async () => {
  const current = fixture('\u{1f319}');
  current.host.limits.maxQuoteCodePoints = 1;
  current.host.limits.maxBodyCodePoints = 24;
  const result = await evaluate(current);
  assert.equal(result.candidate.body, '\u{1f319}\nSource: message:user-1');
});

test('does not mutate frozen caller inputs', async () => {
  const current = fixture();
  Object.freeze(current.host.evidence.get('unit-1'));
  Object.freeze(current.proposal.candidates[0].evidence[0]);
  Object.freeze(current.proposal.candidates[0].evidence);
  Object.freeze(current.proposal.candidates[0]);
  Object.freeze(current.host.limits);
  assert.equal((await evaluate(current)).status, 'candidate');
});

test('builds all literal units and source pointers in selection order', async () => {
  const current = fixture('Alpha only.');
  current.host.evidence.set('unit-2', {
    source: 'tool', success: true, text: 'Approval required. No beta.',
    pointer: 'file:/lunar/entry.md', eligibility: 'durable',
  });
  current.proposal.candidates[0].evidence.push({ sourceId: 'unit-2', quote: 'Approval required. No beta.' });
  const result = await evaluate(current);
  assert.equal(result.candidate.body, 'Alpha only.\nSource: message:user-1\n\nApproval required. No beta.\nSource: file:/lunar/entry.md');
});

test('rejects one code point over budget instead of clipping a constraint', async () => {
  const current = fixture('Alpha only. No beta.');
  current.host.limits.maxQuoteCodePoints = 18;
  assert.deepEqual(await evaluate(current), { status: 'skip', reason: { code: 'quote_budget' } });
});

for (const proposal of [null, [], 'text', {}, { candidates: [null] }, { candidates: [{ evidence: [null] }] }]) {
  test('rejects malformed parsed proposals without throwing or echoing input', async () => {
    const current = fixture();
    current.proposal = proposal;
    assert.deepEqual(await evaluate(current), { status: 'skip', reason: { code: 'invalid_proposal' } });
  });
}

test('rejects malformed Unicode rather than persisting a lone surrogate', async () => {
  const current = fixture('\ud83c');
  assert.deepEqual(await evaluate(current), { status: 'skip', reason: { code: 'invalid_proposal' } });
});
