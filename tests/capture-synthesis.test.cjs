const assert = require('node:assert/strict');
const test = require('node:test');
const { readObservation } = require('./capture-source-host/synthetic.cjs');

async function fixture(text = '# Alpha only\n\nUse docs/entry.md after approval. Never use for beta. A😀中') {
  const api = await import('../plugin/capture/sources.js');
  const { admitCandidate, admitSupport } = await import('../plugin/capture/admission.js');
  const source = api.adaptSource(readObservation(text)).source;
  const quote = source.text;
  const citation = { source_id: source.source_id, content_hash: source.content_hash,
    span: { start: 0, end: [...quote].length }, quote };
  const proposal = { candidates: [{ statements: [{ text: 'Alpha requires approval for docs/entry.md; beta is excluded.', citations: [citation] }] }] };
  const host = { sources: new Map([[source.source_id, source]]), bundles: api.sourceBundles([source]).bundles, userID: 'user' };
  const verdict = { memory: { status: 'accept' }, statements: [{ index: 0, status: 'supported' }], continuity: { status: 'current' } };
  return { api, admitCandidate, admitSupport, source, citation, proposal, host, verdict };
}

test('admits nonliteral concise statements only after independent support', async () => {
  const current = await fixture();
  const result = current.admitCandidate(current.proposal, current.host);
  assert.equal(result.status, 'candidate');
  assert.equal(current.admitSupport(current.verdict, { ...current.host, candidate: result.candidate }).status, 'supported');
  assert.equal(result.candidate.statements[0].text, 'Alpha requires approval for docs/entry.md; beta is excluded.');
});

for (const change of [
  (f) => { f.citation.source_id = 'forged'; },
  (f) => { f.citation.content_hash = 'f'.repeat(64); },
  (f) => { f.citation.span.start = 0.5; },
  (f) => { f.citation.span.end = 99999; },
  (f) => { f.citation.quote = 'invented'; },
  (f) => { f.proposal.candidates[0].placement = 'universal'; },
  (f) => { f.proposal.candidates[0].statements[0].text = '\ud800'; },
]) {
  test('rejects forged or malformed synthesized evidence before support', async () => {
    const current = await fixture();
    change(current);
    assert.equal(current.admitCandidate(current.proposal, current.host).status, 'skip');
  });
}

for (const status of ['unknown', 'unsupported']) {
  test(`rejects ${status} independent support without repair`, async () => {
    const current = await fixture();
    const candidate = current.admitCandidate(current.proposal, current.host).candidate;
    current.verdict.statements[0].status = status;
    assert.equal(current.admitSupport(current.verdict, { ...current.host, candidate }).status, 'skip');
  });
}

test('requires the privately issued witness for mixed continuity without changing old user IDs', async () => {
  const current = await fixture();
  const observation = readObservation('GET job completed and independently verified');
  observation.user_id = 'next'; observation.message.parentID = 'next'; observation.part.id = 'verified';
  const fresh = current.api.adaptSource(observation).source;
  current.host.sources.set(fresh.source_id, fresh);
  current.host.userID = 'next';
  current.host.bundles = [...current.host.bundles, ...current.api.sourceBundles([fresh]).bundles];
  const citation = { source_id: fresh.source_id, content_hash: fresh.content_hash, span: fresh.span, quote: fresh.text };
  current.proposal.candidates[0].statements[0].citations.push(citation);
  const candidate = current.admitCandidate(current.proposal, current.host).candidate;
  current.host.witnessID = 'a'.repeat(64);
  current.verdict.continuity = { status: 'supported', witness_id: current.host.witnessID };
  assert.equal(current.admitSupport(current.verdict, { ...current.host, candidate }).status, 'supported');
  assert.equal(current.source.user_id, 'user');
  current.verdict.continuity.witness_id = 'b'.repeat(64);
  assert.equal(current.admitSupport(current.verdict, { ...current.host, candidate }).status, 'skip');
});

test('screens secret in complete host context even when quotation excludes its tail', async () => {
  const current = await fixture();
  current.host.bundles = [{ ...current.host.bundles[0], units: [{ text: 'api_key=synthetic-value' }] }];
  assert.equal(current.admitCandidate(current.proposal, current.host).reason.code, 'secret');
});

test('deduplicates equivalent citations regardless of JSON field order', async () => {
  const current = await fixture();
  const ref = current.citation;
  current.proposal.candidates[0].statements[0].citations.push({ quote: ref.quote,
    span: { end: ref.span.end, start: ref.span.start }, content_hash: ref.content_hash, source_id: ref.source_id });
  const result = current.admitCandidate(current.proposal, current.host);
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.citations.length, 1);
});

test('accepts mixed witness fields regardless of JSON field order', async () => {
  const current = await fixture();
  const observation = readObservation('GET job completed and independently verified');
  observation.user_id = 'next'; observation.message.parentID = 'next'; observation.part.id = 'verified';
  const fresh = current.api.adaptSource(observation).source;
  const ref = { source_id: fresh.source_id, content_hash: fresh.content_hash, span: fresh.span, quote: fresh.text };
  current.host.sources.set(fresh.source_id, fresh);
  current.host.userID = 'next';
  current.host.bundles = [...current.host.bundles, ...current.api.sourceBundles([fresh]).bundles];
  current.proposal.candidates[0].statements[0].citations.push(ref);
  const candidate = current.admitCandidate(current.proposal, current.host).candidate;
  current.host.witnessID = 'c'.repeat(64);
  current.verdict.continuity = { witness_id: current.host.witnessID, status: 'supported' };
  assert.equal(current.admitSupport(current.verdict, { ...current.host, candidate }).status, 'supported');
});

test('final rendering preserves bounded historical excerpts without copying full support quotes', async () => {
  const current = await fixture();
  const candidate = current.admitCandidate(current.proposal, current.host).candidate;
  const { identify } = await import('../plugin/capture/identity.js');
  const first = identify(candidate.statements, 'repository:fixture', candidate.citations);
  const changedPointer = identify(candidate.statements, 'repository:fixture', candidate.citations.map((citation) => ({ ...citation, pointer: { ...citation.pointer, locator: '/changed' } })));
  assert.equal(first.tag, changedPointer.tag);
  assert.notEqual(first.tag, identify([{ text: 'Different fact under the same condition.' }], 'repository:fixture', candidate.citations).tag);
  const citation = JSON.parse(first.body.slice(first.body.lastIndexOf('\n\nCapture sources: ') + 19)).citations[0];
  assert.deepEqual(Object.keys(citation).sort(), ['content_hash', 'excerpt', 'fragment', 'lines', 'locator', 'observed_at', 'span', 'type']);
  assert.equal(citation.fragment, true);
  assert.equal(citation.excerpt, [...current.citation.quote].slice(0, 32).join(''));
  assert.deepEqual(citation.span, [current.citation.span.start, current.citation.span.start + [...citation.excerpt].length]);
  assert.equal(candidate.citations[0].quote, current.citation.quote);
  assert.equal([...first.body].length <= 1200, true);
});

for (const status of ['reject', 'unknown', undefined]) {
  test(`overall memory ${status} cannot pass even when every statement is supported`, async () => {
    const current = await fixture();
    const candidate = current.admitCandidate(current.proposal, current.host).candidate;
    if (status === undefined) delete current.verdict.memory;
    else current.verdict.memory.status = status;
    assert.deepEqual(current.admitSupport(current.verdict, { ...current.host, candidate }), { status: 'skip', reason: { code: 'memory_rejected' } });
  });
}

for (const extra of ['user_id', 'pointer']) {
  test(`model citations reject host-only ${extra}`, async () => {
    const current = await fixture();
    current.citation[extra] = extra === 'user_id' ? 'user' : current.source.pointer;
    assert.equal(current.admitCandidate(current.proposal, current.host).reason.code, 'evidence_mismatch');
  });
}

test('synthetic full-quote overflow fits the unchanged budget with exact historical fragments', async () => {
  const { identify } = await import('../plugin/capture/identity.js');
  const prose = 'In the synthetic alpha sandbox, docs/alpha.md requires approval and must never be used for beta. A separate local marker check passed; that check does not independently verify the alpha repair or grant permission to execute the route.';
  const quotes = ['For alpha, start at docs/alpha.md after approval. Never use for beta.\n'.repeat(6),
    '{"verifier":"separate-local-marker-check","passed":true}\n'.repeat(3)];
  const { createHash } = require('node:crypto');
  const citations = quotes.map((quote, index) => ({ source_id: `synthetic_source_${index}`, user_id: 'synthetic_user',
    content_hash: createHash('sha256').update(quote).digest('hex'), span: { start: 0, end: [...quote].length }, quote,
    pointer: { type: index === 0 ? 'file' : 'message_part', locator: index === 0 ? '/synthetic/project/docs/alpha.md' : 'synthetic_assistant/synthetic_part', observed_at: 1700000000000 } }));
  const legacy = prose + '\n\nCapture sources: ' + JSON.stringify({ statements: [prose.length], citations });
  assert.ok([...legacy].length > 1200);
  const repaired = identify([{ text: prose }], 'repository:fixture', citations);
  assert.ok([...repaired.body].length <= 1200);
  const persisted = JSON.parse(repaired.body.split('\n\nCapture sources: ')[1]).citations;
  assert.deepEqual(persisted.map((citation) => citation.excerpt), quotes.map((quote) => [...quote].slice(0, 32).join('')));
  assert.equal(repaired.body.startsWith(prose + '\n\nCapture sources: '), true);
});

for (const quote of ['😀', 'a'.repeat(32), 'b'.repeat(33), '中😀\n"\\'.repeat(10)]) {
  test(`historical fragment spans remain exact after JSON escaping for ${[...quote].length}CP`, async () => {
    const prefix = '# Alpha\n\nxx';
    const current = await fixture(prefix + quote + '\nThe complete source retains its conditions.');
    current.citation.span = { start: [...prefix].length, end: [...prefix + quote].length };
    current.citation.quote = quote;
    const candidate = current.admitCandidate(current.proposal, current.host).candidate;
    const { identify } = await import('../plugin/capture/identity.js');
    const identity = identify(candidate.statements, 'repository:fixture', candidate.citations);
    const persisted = JSON.parse(identity.body.split('\n\nCapture sources: ')[1]).citations[0];
    assert.equal(persisted.fragment, true);
    assert.equal(persisted.excerpt, [...quote].slice(0, 32).join(''));
    assert.equal(persisted.excerpt, [...current.source.text].slice(persisted.span[0], persisted.span[1]).join(''));
    assert.equal(persisted.span[0], current.citation.span.start);
    assert.equal(persisted.span[1], current.citation.span.start + Math.min(32, [...quote].length));
    assert.equal(persisted.content_hash, current.source.content_hash);
    assert.equal(candidate.citations[0].quote, quote);
    assert.ok([...identity.body].length <= 1200);
  });
}
