import { createHash } from 'node:crypto';

const footer = '\n\nCapture sources: ';
const canonical = (text) => text.replace(/\r\n?/g, '\n').trim();
const knowledge = (units) => [...new Set(units.map((unit) => canonical(unit.text)))].sort();

export function serializeCaptureProvenance(statementLengths, citations) {
  return footer + JSON.stringify({ statements: statementLengths, citations: citations.map((citation) => {
    const excerpt = [...citation.quote].slice(0, 32).join('');
    return { content_hash: citation.content_hash,
      span: [citation.span.start, citation.span.start + [...excerpt].length], excerpt, fragment: true,
      type: citation.pointer.type, locator: citation.pointer.locator, observed_at: citation.pointer.observed_at,
      ...(citation.pointer.line_range ? { lines: [citation.pointer.line_range.start, citation.pointer.line_range.end] } : {}) };
  }) });
}

export function identify(units, placement, citations) {
  const raw = Object.freeze(knowledge(units));
  const key = JSON.stringify([placement, raw]);
  const fingerprint = createHash('sha256').update(key).digest('hex');
  const tag = `memocap-capture-${fingerprint}`;
  const provenance = citations ? serializeCaptureProvenance(units.map((unit) => unit.text.length), citations) :
    footer + JSON.stringify(units.map((unit) => ({ length: unit.text.length, pointer: unit.pointer })));
  const body = units.map((unit) => unit.text).join('\n\n') + provenance;
  return Object.freeze({ body, placement, raw, key, fingerprint, tag, tags: Object.freeze([tag]) });
}

export function sameKnowledge(memory, candidate) {
  if (memory.placement !== candidate.placement || !memory.tags?.split(',').includes(candidate.tag)) return false;
  const boundary = memory.content.lastIndexOf(footer);
  if (boundary < 0) return false;
  let sources;
  try { sources = JSON.parse(memory.content.slice(boundary + footer.length)); } catch { return false; }
  if (sources && !Array.isArray(sources) && Array.isArray(sources.statements) && Array.isArray(sources.citations)) {
    let offset = 0;
    const units = [];
    for (const length of sources.statements) {
      if (!Number.isSafeInteger(length) || length <= 0 || offset + length > boundary) return false;
      units.push({ text: memory.content.slice(offset, offset + length) });
      offset += length + 2;
      if (offset < boundary + 2 && memory.content.slice(offset - 2, offset) !== '\n\n') return false;
    }
    return offset === boundary + 2 && JSON.stringify(knowledge(units)) === JSON.stringify(candidate.raw);
  }
  if (!Array.isArray(sources) || !sources.length) return false;
  const units = [];
  let offset = 0;
  for (const source of sources) {
    if (!source || !Number.isSafeInteger(source.length) || source.length <= 0 ||
        typeof source.pointer !== 'string' || !/^(?:message|tool):\S+$/.test(source.pointer)) return false;
    const end = offset + source.length;
    if (end > boundary) return false;
    units.push({ text: memory.content.slice(offset, end) });
    offset = end + 2;
    if (end !== boundary && memory.content.slice(end, offset) !== '\n\n') return false;
  }
  return offset === boundary + 2 && JSON.stringify(knowledge(units)) === JSON.stringify(candidate.raw);
}
