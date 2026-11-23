import { exactObject, hash, parseName, parseText, requireMaintenance } from "./boundary.js";

export function uniqueQuoteSpan(content, quote) {
  const offset = content.indexOf(quote);
  if (offset < 0 || content.indexOf(quote, offset + 1) >= 0) return null;
  const start = Array.from(content.slice(0, offset)).length;
  return { start, end: start + Array.from(quote).length, quote };
}

export function resolveModelCitations(citations, evidence) {
  requireMaintenance(Array.isArray(citations) && citations.length > 0 && citations.length <= 12, "invalid_request");
  const sources = new Map(evidence.map((source) => [source.source_id, source]));
  requireMaintenance(sources.size === evidence.length, "evidence_mismatch");
  return citations.map((citation) => {
    exactObject(citation, ["source_id", "quote"]);
    const { source_id, quote } = citation;
    parseName(source_id); parseText(quote);
    requireMaintenance(quote.length > 0, "invalid_request");
    const source = sources.get(source_id);
    requireMaintenance(source && source.outcome === "observed" && source.completeness === "full", "evidence_mismatch");
    parseText(source.text, 16384);
    const content_hash = hash(source.text);
    requireMaintenance(content_hash === source.content_hash, "evidence_hash_mismatch");
    const span = uniqueQuoteSpan(source.text, quote);
    requireMaintenance(span, "evidence_span_mismatch");
    return { source_id, content_hash, ...span };
  });
}
