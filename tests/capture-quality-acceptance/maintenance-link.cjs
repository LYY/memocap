const { isDeepStrictEqual: equal } = require('node:util');
const { hash } = require('./definitions.cjs');

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value) => typeof value === 'string' && value.length > 0 && value.isWellFormed() && !value.includes('\0');
const quoteKeys = ['source_id', 'quote'];
const hashedQuoteKeys = [...quoteKeys, 'content_hash'];
const offsetKeys = [...hashedQuoteKeys, 'start', 'end'];

function sourceIndex(evidence) {
  if (!Array.isArray(evidence) || evidence.length > 12) return null;
  const sources = new Map();
  for (const source of evidence) {
    if (!text(source?.source_id) || sources.has(source.source_id) || typeof source.text !== 'string' ||
      !source.text.isWellFormed() || source.text.includes('\0') || source.text.length > 16384) return null;
    const content_hash = hash(source.text);
    if (content_hash !== source.content_hash) return null;
    sources.set(source.source_id, { ...source, content_hash });
  }
  return sources;
}

function quoteSpan(citation, source) {
  const offset = source.text.indexOf(citation.quote);
  if (offset < 0 || source.text.lastIndexOf(citation.quote) !== offset) return null;
  const start = [...source.text.slice(0, offset)].length;
  return { source_id: citation.source_id, content_hash: source.content_hash, start,
    end: start + [...citation.quote].length, quote: citation.quote };
}

function resolvedCitations(citations, sources, keys) {
  if (!Array.isArray(citations) || !citations.length || citations.length > 12) return null;
  const legacy = keys === offsetKeys;
  const spans = [];
  let corrected = false;
  for (const citation of citations) {
    if (!exact(citation, keys) || !text(citation.quote)) return null;
    const source = sources.get(citation.source_id);
    if (source?.outcome !== 'observed' || source.completeness !== 'full' ||
      (keys !== quoteKeys && source.content_hash !== citation.content_hash)) return null;
    if (legacy &&
      Number.isSafeInteger(citation.start) && Number.isSafeInteger(citation.end) && citation.start >= 0 &&
      citation.end > citation.start && citation.end <= [...source.text].length &&
      [...source.text].slice(citation.start, citation.end).join('') === citation.quote) {
      spans.push(citation);
      continue;
    }
    const span = quoteSpan(citation, source);
    if (!span || legacy && (citation.start !== span.start || citation.end !== span.end - 1 || citation.end <= citation.start)) return null;
    corrected ||= legacy;
    spans.push(span);
  }
  if (new Set(spans.map((span) => span.source_id)).size > 2 || spans.reduce((sum, span) => sum + span.end - span.start, 0) > 800) return null;
  return { spans, corrected };
}

function currentContext(raw, proposal, assessment, keys) {
  const current = raw.used.filter((use) => equal(use?.task, proposal.task));
  const prior = raw.used.filter((use) => !equal(use?.task, proposal.task));
  if (!prior.length) return equal(raw.used, proposal.used) ? { evidence: raw.evidence, handles: new Map() } : null;
  if (keys === offsetKeys) return null;
  const decision = raw.candidate.decision;
  const targets = decision.action === 'merge' && Array.isArray(decision.sources) ? [decision.target, ...decision.sources] : [decision.target];
  const currentEvidence = raw.evidence.filter((source) => equal(source.task, proposal.task));
  if (targets.every((target) => current.some((use) => use.use_id === target))) {
    return equal(current, proposal.used) ? { evidence: currentEvidence, handles: new Map() } : null;
  }
  const input = raw.candidate.continuity;
  if (!exact(input, ['status', 'goal', 'object', 'environment', 'citations']) || input.status !== 'same_task' ||
    ![input.goal, input.object, input.environment].every((value) => text(value) && value.trim() && value.length <= 256) ||
    assessment.continuity !== 'supported' || proposal.used.length !== raw.used.length ||
    !equal(current, proposal.used.slice(0, current.length))) return null;
  const citations = resolvedCitations(input.citations, sourceIndex(raw.evidence), keys)?.spans;
  const priorEvidence = raw.evidence.filter((source) => !equal(source.task, proposal.task));
  if (!citations?.some((citation) => currentEvidence.some((source) => source.source_id === citation.source_id)) ||
    !citations.some((citation) => priorEvidence.some((source) => source.source_id === citation.source_id))) return null;
  const continuity = { ...input, citations, evidence: priorEvidence.map(hash) };
  const handles = new Map();
  for (const [index, use] of prior.entries()) {
    const continued = proposal.used[current.length + index];
    const adoption = use.adoption ?? { task: use.task, caller: use.caller, use_id: use.use_id, receipt_id: use.receipt_id };
    if (!text(continued?.use_id) || !equal(continued, { ...use, use_id: continued.use_id, task: proposal.task, adoption, continuation: continuity })) return null;
    handles.set(use.use_id, continued.use_id);
  }
  return { evidence: raw.evidence, handles };
}

function matchesRawDecision(raw, proposal, validated, assessment) {
  const decision = raw?.candidate?.decision;
  if (!decision || !Array.isArray(raw.used) || !raw.used.length || raw.used.length > 3 ||
    raw.used.some((use) => !text(use?.use_id)) || !sourceIndex(raw.evidence)) return false;
  const citations = decision.citations;
  if (!Array.isArray(citations)) return false;
  const hasOffsets = citations.some((citation) => citation && (Object.hasOwn(citation, 'start') || Object.hasOwn(citation, 'end')));
  const keys = hasOffsets ? offsetKeys : exact(citations[0], quoteKeys) ? quoteKeys : hashedQuoteKeys;
  const context = currentContext(raw, proposal, assessment, keys);
  if (!context) return false;
  const evidence = decision.action === 'delete' && Array.isArray(decision.retirement_evidence_ids)
    ? context.evidence.map((source) => decision.retirement_evidence_ids.includes(source.source_id) ? { ...source, kind: 'retirement' } : source)
    : context.evidence;
  if (!equal(evidence, proposal.evidence)) return false;
  const resolved = resolvedCitations(citations, sourceIndex(evidence), keys);
  // The marker is necessary for historical one-short replay, but never substitutes for recomputing the original span.
  const marker = validated.citation_offset_correction;
  if (!resolved || (resolved.corrected ? marker !== 'exclusive_end_plus_one' : marker !== undefined)) return false;
  const { handles } = context;
  const mapped = { ...decision, target: handles.get(decision.target) ?? decision.target, citations: resolved.spans };
  if (decision.action === 'merge' && Array.isArray(decision.sources)) mapped.sources = decision.sources.map((handle) => handles.get(handle) ?? handle);
  return equal(mapped, proposal.decision);
}

module.exports = { matchesRawDecision };
