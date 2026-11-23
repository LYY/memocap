import { limits } from './contract.js';
import { clean } from './screen.js';
import { isBundle } from './sources/sections.js';
import { freeze, normalize } from './sources/value.js';
import { resolveQuote } from './sources.js';

const skip = (code) => ({ status: 'skip', reason: { code } });
const fields = (value, names) => value !== null && typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every((name) => names.includes(name));
const text = (value) => typeof value === 'string' && value.trim() && value.isWellFormed();
const referenceShape = (value) => fields(value, ['source_id', 'content_hash', 'span', 'quote']) &&
  fields(value.span, ['start', 'end']) && text(value.quote);

function reference(value, host) {
  if (!referenceShape(value)) return;
  const source = host.sources.get(value.source_id);
  if (resolveQuote(source, value) === undefined) return;
  if (!host.bundles.some((bundle) => isBundle(bundle) && bundle.source_id === value.source_id &&
      bundle.units.some((unit) => value.span.start >= unit.span.start && value.span.end <= unit.span.end))) return;
  return { source_id: source.source_id, content_hash: source.content_hash,
    span: { start: value.span.start, end: value.span.end }, quote: value.quote,
    user_id: source.user_id, pointer: source.pointer };
}

export function admitCandidate(proposal, host) {
  if (!(host.sources instanceof Map) || !Array.isArray(host.bundles)) return skip('invalid_host_input');
  if (!clean([proposal, [...host.sources.values()], host.bundles])) return skip('secret');
  if (!fields(proposal, ['candidates']) || !Array.isArray(proposal.candidates)) return skip('invalid_proposal');
  if (proposal.candidates.length > 1) return skip('multiple_candidates');
  if (!proposal.candidates.length) return skip('no_candidate');
  const candidate = proposal.candidates[0];
  if (!fields(candidate, ['statements', 'kind']) ||
      (candidate.kind !== undefined && !['convention', 'decision', 'context', 'runbook'].includes(candidate.kind)) ||
      !Array.isArray(candidate.statements) || !candidate.statements.length || candidate.statements.length > 4) return skip('invalid_proposal');
  const statements = [];
  const citations = new Map();
  for (const statement of candidate.statements) {
    if (!fields(statement, ['text', 'citations']) || !text(statement.text) ||
        !Array.isArray(statement.citations) || !statement.citations.length || statement.citations.length > 2) return skip('invalid_proposal');
    const refs = [];
    for (const citation of statement.citations) {
      const resolved = reference(citation, host);
      if (!resolved) return skip('evidence_mismatch');
      const key = JSON.stringify(resolved);
      citations.set(key, resolved);
      refs.push(resolved);
    }
    statements.push({ text: normalize(statement.text).trim(), citations: refs });
  }
  const unique = [...citations.values()];
  if (unique.length > limits.maxEvidenceUnits) return skip('evidence_budget');
  if (unique.reduce((count, citation) => count + [...citation.quote].length, 0) > limits.maxQuoteCodePoints) return skip('quote_budget');
  if (!unique.some((citation) => citation.user_id === host.userID)) return skip('current_evidence_required');
  if (statements.reduce((count, statement) => count + [...statement.text].length, 0) > limits.maxBodyCodePoints) return skip('body_budget');
  return { status: 'candidate', candidate: freeze({ statements, citations: unique,
    ...(candidate.kind === undefined ? {} : { kind: candidate.kind }) }) };
}

export function admitSupport(verdict, host) {
  if (!clean(verdict) || !fields(verdict, ['memory', 'statements', 'continuity']) ||
      !Array.isArray(verdict.statements) || verdict.statements.length !== host.candidate.statements.length ||
      !verdict.statements.every((entry, index) => fields(entry, ['index', 'status']) && entry.index === index && entry.status === 'supported')) return skip('unsupported');
  if (!fields(verdict.memory, ['status'])) return skip('memory_rejected');
  const memoryStatus = verdict.memory.status;
  const continuity = verdict.continuity;
  // admitCandidate already requires a current citation, so a prior citation makes this mixed.
  const citesPrior = host.candidate.citations.some((citation) => citation.user_id !== host.userID);
  if (memoryStatus !== 'accept' && (memoryStatus !== 'reject' || !citesPrior)) return skip('memory_rejected');
  if (!citesPrior && !host.hasPriorSources) {
    if (!fields(continuity, ['status']) || continuity.status !== 'current') return skip('continuity_unknown');
    return { status: 'supported' };
  }
  const expectedStatus = citesPrior ? 'supported' : 'standalone';
  if (!fields(continuity, ['status', 'witness_id']) || continuity.status !== expectedStatus ||
      !text(host.witnessID) || continuity.witness_id !== host.witnessID) {
    return skip(memoryStatus === 'reject' ? 'memory_rejected' : 'continuity_unknown');
  }
  if (memoryStatus === 'reject') return skip('memory_rejected_mixed_support');
  return { status: 'supported' };
}
