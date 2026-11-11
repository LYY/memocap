/**
 * Pure capture admission, with no I/O, logging, persistence or model calls.
 *
 * Public API: admitCandidate(proposal, host).
 * proposal is parsed JSON, exactly { candidates: [] | [candidate] }.
 * candidate is exactly { evidence: [{ sourceId, quote }], kind? }.
 * kind is optional convention | decision | context | runbook, metadata only.
 * No model body, target, database, repository, domain, universal, topic or force
 * field is accepted. A later adapter owns placement and must NEVER pass topic
 * or force: topic is frozen host metadata; force needs separate authorization.
 *
 * host is { evidence: Map<string, EvidenceUnit>, limits, existingBodies }.
 * EvidenceUnit: { source: 'user' | 'tool', text: string, pointer: string,
 *   eligibility: 'durable' | 'ephemeral' | 'unsupported' | 'runbook', success? }.
 * Tool units require success === true, independently established by the host.
 * IDs, units, source identity, success and pointers MUST come from the host,
 * never from model-supplied evidence objects. Pointers identify provenance,
 * not permission or proof of a successful business outcome.
 *
 * eligibility is the caller's policy assessment, NOT a computed truth label.
 * The later policy/model review decides durability, unsupported guesses and
 * full-runbook copying; only reviewed durable units are eligible here. Do not
 * blindly promote a model's label into this host field. The host adapter must
 * bound complete evidence units while preserving all conditions and negation.
 * A concise task/tool or service/environment/repository route remains eligible
 * even when maintained docs contain it. Read its current source before acting.
 *
 * limits requires ALL nonnegative safe integers: maxEvidenceUnits,
 * maxQuoteCodePoints (aggregate), maxBodyCodePoints (including pointers).
 * There are no production budget defaults. Oversized units/bodies are rejected,
 * never truncated. Text must be well-formed Unicode; budgets count code points.
 * existingBodies is a string array from the caller's authorized duplicate read.
 * Duplicate comparison only normalizes CRLF/CR to LF and trims outer whitespace;
 * it does not rewrite the returned literal text or find semantic equivalents.
 *
 * Returns { status: 'candidate', candidate: { body, sources, kind? } } or
 * { status: 'skip', reason: { code } }. sources is [{ sourceId, pointer }].
 * body joins each complete literal unit + '\nSource: ' + its host pointer with
 * '\n\n', in proposal order. Every quote must exactly equal its entire unit.
 * Skip results contain static codes only, never rejected text or secret values.
 * Secret patterns are a conservative boundary screen, not an exhaustive secret
 * detector. Matching evidence establishes provenance, not arbitrary truth,
 * semantic admission, business success or semantic duplicate detection.
 * Frozen capture.json contains labels only, not measured AI admission quality.
 */

const kinds = new Set(['convention', 'decision', 'context', 'runbook']);
const secretPatterns = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/i,
  /\b(?:authorization\s*:\s*)?bearer\s+\S+/i,
  /\b(?:password|passwd|pwd|secret|token|(?:access|refresh|auth)[_ -]?token|api[_ -]?key|access[_ -]?key|client[_ -]?secret)\b["']?\s*(?:[:=]|\bis\b)\s*\S+/i,
  /\b(?:store|save|remember)\s+(?:the\s+)?(?:password|secret|credentials?)\b/i,
  /\bcredentials?\b\s*(?:[:=]|[<"'])\s*\S+/i,
  /(?:密码|密钥|令牌|凭据)\s*[:：=]\s*\S+/u,
  /[a-z][a-z\d+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
];

const skip = (code) => ({ status: 'skip', reason: { code } });
const secret = (text) => secretPatterns.some((pattern) => pattern.test(text));
const canonical = (text) => text.replace(/\r\n?/g, '\n').trim();
const text = (input) => typeof input === 'string' && input.trim().length > 0 && input.isWellFormed();

function fields(input, allowed) {
  return input !== null && typeof input === 'object' &&
    Object.getPrototypeOf(input) === Object.prototype &&
    Reflect.ownKeys(input).every((key) => allowed.includes(key));
}

function validHost(host) {
  if (!fields(host, ['evidence', 'limits', 'existingBodies']) ||
      !(host.evidence instanceof Map) || !Array.isArray(host.existingBodies) ||
      !host.existingBodies.every((body) => typeof body === 'string')) return false;
  const names = ['maxEvidenceUnits', 'maxQuoteCodePoints', 'maxBodyCodePoints'];
  return fields(host.limits, names) && names.every((name) =>
    Number.isSafeInteger(host.limits[name]) && host.limits[name] >= 0);
}

function validCandidate(candidate) {
  return fields(candidate, ['kind', 'evidence']) &&
    (!Object.hasOwn(candidate, 'kind') || kinds.has(candidate.kind)) &&
    Array.isArray(candidate.evidence) && candidate.evidence.length > 0 &&
    candidate.evidence.every((support) => fields(support, ['sourceId', 'quote']) &&
      text(support.sourceId) && text(support.quote));
}

function evidenceReason(unit) {
  if (!fields(unit, ['source', 'success', 'text', 'pointer', 'eligibility']) ||
      !text(unit.text) || !text(unit.pointer)) return 'invalid_host_input';
  if (secret(unit.text) || secret(unit.pointer)) return 'secret';
  switch (unit.source) {
    case 'user': break;
    case 'tool':
      if (unit.success !== true) return 'unsupported_source';
      break;
    default: return 'unsupported_source';
  }
  switch (unit.eligibility) {
    case 'durable': return null;
    case 'ephemeral': return 'no_durable_value';
    case 'runbook': return 'runbook_copy';
    case 'unsupported': return 'insufficient_evidence';
    default: return 'insufficient_evidence';
  }
}

export function admitCandidate(proposal, host) {
  if (!validHost(host)) return skip('invalid_host_input');
  if (!fields(proposal, ['candidates']) || !Array.isArray(proposal.candidates)) return skip('invalid_proposal');
  if (proposal.candidates.length > 1) return skip('multiple_candidates');
  if (proposal.candidates.length === 0) return skip('no_candidate');
  const candidate = proposal.candidates[0];
  if (!validCandidate(candidate)) return skip('invalid_proposal');
  if (candidate.evidence.length > host.limits.maxEvidenceUnits) return skip('evidence_budget');
  const seen = new Set();
  const parts = [];
  const sources = [];
  let quoteSize = 0;
  for (const support of candidate.evidence) {
    if (secret(support.quote) || secret(support.sourceId)) return skip('secret');
    if (seen.has(support.sourceId)) return skip('duplicate_evidence');
    seen.add(support.sourceId);
    if (!host.evidence.has(support.sourceId)) return skip('missing_evidence');
    const unit = host.evidence.get(support.sourceId);
    const reason = evidenceReason(unit);
    if (reason) return skip(reason);
    if (support.quote !== unit.text) return skip('evidence_mismatch');
    quoteSize += Array.from(unit.text).length;
    if (quoteSize > host.limits.maxQuoteCodePoints) return skip('quote_budget');
    parts.push(`${unit.text}\nSource: ${unit.pointer}`);
    sources.push({ sourceId: support.sourceId, pointer: unit.pointer });
  }
  const body = parts.join('\n\n');
  if (Array.from(body).length > host.limits.maxBodyCodePoints) return skip('body_budget');
  if (host.existingBodies.some((existing) => canonical(existing) === canonical(body))) return skip('duplicate_body');
  return { status: 'candidate', candidate: {
    body, sources, ...(candidate.kind === undefined ? {} : { kind: candidate.kind }),
  } };
}
