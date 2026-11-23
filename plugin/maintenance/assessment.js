import { exactObject, fingerprint, hash, immutable, parseDigest, parseName, parseTask, parseText, requireMaintenance,
  sameTask } from "./boundary.js";

const citationKeys = ["source_id", "start", "end", "quote", "content_hash"];

function parseEvidence(input) {
  exactObject(input, ["source_id", "task", "kind", "outcome", "completeness", "text", "content_hash"]);
  parseName(input.source_id); parseTask(input.task); parseText(input.text, 16384); parseDigest(input.content_hash);
  requireMaintenance(["source", "validation", "retirement"].includes(input.kind) &&
    ["observed", "missing", "404", "timeout", "deny"].includes(input.outcome) &&
    ["full", "fragment", "unknown"].includes(input.completeness), "invalid_request");
  requireMaintenance(hash(input.text) === input.content_hash, "evidence_hash_mismatch");
  return structuredClone(input);
}

export function validateCitations(citations, evidence) {
  requireMaintenance(Array.isArray(citations) && citations.length > 0 && citations.length <= 12, "invalid_request");
  let cited = 0;
  for (const citation of citations) {
    exactObject(citation, citationKeys);
    parseName(citation.source_id); parseText(citation.quote); parseDigest(citation.content_hash);
    const source = evidence.find((entry) => entry.source_id === citation.source_id);
    requireMaintenance(source && source.content_hash === citation.content_hash, "evidence_mismatch");
    requireMaintenance(Number.isSafeInteger(citation.start) && Number.isSafeInteger(citation.end) && citation.start >= 0 &&
      citation.end > citation.start && citation.end <= Array.from(source.text).length, "invalid_request");
    requireMaintenance(Array.from(source.text).slice(citation.start, citation.end).join("") === citation.quote, "evidence_span_mismatch");
    cited += citation.end - citation.start;
  }
  requireMaintenance(cited <= 800 && new Set(citations.map((entry) => entry.source_id)).size <= 2, "input_budget");
}

export function validateMaintenanceDecision(input, { used, evidence: observations }) {
  requireMaintenance(Array.isArray(used) && used.length > 0 && used.length <= 3 &&
    Array.isArray(observations) && observations.length <= 12, "input_budget");
  const evidence = observations.map(parseEvidence);
  requireMaintenance(new Set(evidence.map((entry) => entry.source_id)).size === evidence.length &&
    evidence.every((entry) => sameTask(entry.task, used[0].task) ||
      used.some((use) => use.continuation?.evidence.includes(fingerprint(entry)))), "evidence_mismatch");
  requireMaintenance(input && typeof input === "object", "invalid_request");
  if (Object.hasOwn(input, "citations")) validateCitations(input.citations, evidence);
  switch (input.action) {
    case "keep": case "unknown": exactObject(input, ["action", "target"]); break;
    case "update":
      exactObject(input, ["action", "target", "content", "citations"]);
      break;
    case "merge":
      exactObject(input, ["action", "target", "sources", "content", "citations"]);
      requireMaintenance(Array.isArray(input.sources) && input.sources.length > 0 && input.sources.length <= 2, "invalid_request");
      input.sources.forEach(parseName);
      break;
    case "delete":
      exactObject(input, ["action", "target", "citations", "retirement_evidence_ids", "remaining_unique_facts"]);
      requireMaintenance(Array.isArray(input.retirement_evidence_ids) && input.retirement_evidence_ids.length > 0 &&
        input.retirement_evidence_ids.length <= 2 && new Set(input.retirement_evidence_ids).size === input.retirement_evidence_ids.length &&
        Array.isArray(input.remaining_unique_facts) && input.remaining_unique_facts.length === 0, "retirement_required");
      requireMaintenance(input.retirement_evidence_ids.every((sourceID) => evidence.some((entry) => entry.source_id === sourceID &&
        entry.kind === "retirement") && input.citations.some((citation) => citation.source_id === sourceID)), "retirement_required");
      break;
    default: requireMaintenance(false, "invalid_request");
  }
  parseName(input.target);
  const handles = participantIDs(input);
  requireMaintenance(new Set(handles).size === handles.length, "invalid_request");
  requireMaintenance(handles.every((handle) => used.some((entry) => entry.use_id === handle)), "reference_unavailable");
  requireMaintenance(input.action !== "merge" || new Set(used.filter((entry) => handles.includes(entry.use_id)).map((entry) => entry.snapshot.placement)).size === 1, "placement_mismatch");
  if (Object.hasOwn(input, "content")) {
    parseText(input.content); requireMaintenance(input.content.trim().length > 0 && Array.from(input.content).length <= 1200, "input_budget");
  }
  const cited = new Set(input.citations?.map((citation) => citation.source_id) ?? []);
  const decision = evidence.filter((source) => cited.has(source.source_id)).some((source) => source.outcome !== "observed" || source.completeness !== "full")
    ? { action: "unknown", target: input.target } : structuredClone(input);
  requireMaintenance(Buffer.byteLength(JSON.stringify([used, evidence, decision])) <= 65536, "input_budget");
  return immutable({ decision, evidence, decision_fingerprint: fingerprint([input, used]), evidence_fingerprint: fingerprint(evidence), semantics: "unverified" });
}

export function participantIDs(decision) {
  switch (decision.action) {
    case "merge": return [decision.target, ...decision.sources];
    case "update": case "delete": case "keep": case "unknown": return [decision.target];
    default: requireMaintenance(false, "invalid_request");
  }
}
