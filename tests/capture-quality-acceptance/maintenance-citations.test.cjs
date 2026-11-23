const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('./definitions.cjs');
const { matchesRawDecision } = require('./maintenance-link.cjs');

function continuationProof() {
  const task = { parentID: 'parent', taskID: 'current', epoch: 2 };
  const previous = { ...task, taskID: 'prior', epoch: 1 };
  const currentText = '\u{1f9ea} Ready now.';
  const priorText = 'Earlier approval.';
  const evidence = [
    { task, source_id: 'current', text: currentText, content_hash: hash(currentText), outcome: 'observed', completeness: 'full' },
    { task: previous, source_id: 'prior', text: priorText, content_hash: hash(priorText), outcome: 'observed', completeness: 'full' },
  ];
  const current = { source_id: 'current', quote: 'Ready now.' };
  const prior = { source_id: 'prior', quote: 'Earlier approval.' };
  const canonicalCurrent = { ...current, content_hash: hash(currentText), start: 2, end: 12 };
  const canonicalPrior = { ...prior, content_hash: hash(priorText), start: 0, end: 17 };
  const context = { status: 'same_task', goal: 'Finish review', object: 'Approval', environment: 'Test' };
  const continuity = { ...context, citations: [current, prior] };
  const decision = { action: 'update', target: 'old-use', content: 'Approval is ready.', citations: [current] };
  const currentUse = { task, use_id: 'current-use' };
  const oldUse = { task: previous, use_id: 'old-use', caller: 'review', receipt_id: 'receipt' };
  const continued = { ...oldUse, task, use_id: 'continued-use', adoption: oldUse,
    continuation: { ...context, citations: [canonicalCurrent, canonicalPrior], evidence: [hash(evidence[1])] } };
  return {
    raw: { used: [currentUse, oldUse], evidence, candidate: { decision, continuity } },
    proposal: { task, used: [currentUse, continued], evidence,
      decision: { ...decision, target: continued.use_id, citations: [{ ...canonicalCurrent }] } },
  };
}

const quoteOnly = 'source and quote';
const fullHash = 'historical full hash';
for (const [decisionFormat, continuityFormat, linked] of [
  [quoteOnly, quoteOnly, true],
  [fullHash, fullHash, true],
  [quoteOnly, fullHash, false],
  [fullHash, quoteOnly, false],
]) test(`inherited citation proof: decision ${decisionFormat}, continuity ${continuityFormat}`, () => {
  const { raw, proposal } = continuationProof();
  const { continuity, decision } = raw.candidate;
  const hashed = raw.evidence.map(({ source_id, content_hash }, index) => ({ source_id, content_hash, quote: continuity.citations[index].quote }));
  if (decisionFormat === fullHash) decision.citations = [hashed[0]];
  if (continuityFormat === fullHash) continuity.citations = hashed;

  assert.equal(matchesRawDecision(raw, proposal, {}, { continuity: 'supported' }), linked);
});

test('current-only decision ignores unused continuity with a different citation format', () => {
  const { raw, proposal } = continuationProof();
  raw.candidate.decision.target = raw.used[0].use_id;
  raw.candidate.continuity.citations = proposal.used[1].continuation.citations.map(({ source_id, quote, content_hash }) =>
    ({ source_id, quote, content_hash }));
  proposal.decision.target = raw.candidate.decision.target;
  proposal.used = [raw.used[0]];
  proposal.evidence = [raw.evidence[0]];

  assert.equal(matchesRawDecision(raw, proposal, {}, { continuity: 'supported' }), true);
});

for (const [variant, tamper] of Object.entries({
  'canonical decision hash': ({ proposal }) => { proposal.decision.citations = [{ ...proposal.decision.citations[0], content_hash: 'a'.repeat(64) }]; },
  'canonical continuity hash': ({ proposal }) => { proposal.used[1].continuation.citations[1].content_hash = 'a'.repeat(64); },
  'source metadata hash': ({ raw }) => { raw.evidence[0].content_hash = 'a'.repeat(64); },
  'foreign decision quote': ({ raw }) => { raw.candidate.decision.citations = [{ source_id: 'current', quote: 'Earlier approval.' }]; },
  'foreign continuity quote': ({ raw }) => { raw.candidate.continuity.citations[1] = { source_id: 'prior', quote: 'Ready now.' }; },
  'ambiguous decision quote': ({ raw, proposal }) => {
    const source = raw.evidence[0];
    source.text += ' Ready now.';
    source.content_hash = hash(source.text);
    proposal.decision.citations[0].content_hash = source.content_hash;
    raw.candidate.continuity.citations[0] = { source_id: 'current', quote: source.text };
    proposal.used[1].continuation.citations[0] = { source_id: 'current', quote: source.text,
      content_hash: source.content_hash, start: 0, end: 23 };
  },
  'ambiguous continuity quote': ({ raw, proposal }) => {
    const source = raw.evidence[1];
    source.text += ` ${source.text}`;
    source.content_hash = hash(source.text);
    proposal.used[1].continuation.citations[1].content_hash = source.content_hash;
    proposal.used[1].continuation.evidence = [hash(source)];
  },
  'invalid historical hash': ({ raw }) => { raw.candidate.decision.citations = [{ ...raw.candidate.decision.citations[0], content_hash: 'a'.repeat(64) }]; },
  'mixed decision formats': ({ raw, proposal }) => {
    const [current, prior] = proposal.used[1].continuation.citations;
    const { source_id, quote, content_hash } = prior;
    raw.candidate.decision.citations.push({ source_id, quote, content_hash });
    proposal.decision.citations = [current, prior];
  },
})) test(`citation proof rejects ${variant}`, () => {
  const fixture = continuationProof();
  tamper(fixture);

  assert.equal(matchesRawDecision(fixture.raw, fixture.proposal, {}, { continuity: 'supported' }), false);
});
