import { createHash } from 'node:crypto';

const footer = '\n\nCapture sources: ';
const canonical = (text) => text.replace(/\r\n/g, '\n').trim();
const knowledge = (units) => [...new Set(units.map((unit) => canonical(unit.text)))].sort();

export function identify(units, placement) {
  const raw = Object.freeze(knowledge(units));
  const key = JSON.stringify([placement, raw]);
  const fingerprint = createHash('sha256').update(key).digest('hex');
  const tag = `memocap-capture-${fingerprint}`;
  const provenance = units.map((unit) => ({ length: unit.text.length, pointer: unit.pointer }));
  const body = units.map((unit) => unit.text).join('\n\n') + footer + JSON.stringify(provenance);
  return Object.freeze({ body, placement, raw, key, fingerprint, tag, tags: Object.freeze([tag]) });
}

export function sameKnowledge(memory, candidate) {
  if (memory.placement !== candidate.placement || !memory.tags?.split(',').includes(candidate.tag)) return false;
  const boundary = memory.content.lastIndexOf(footer);
  if (boundary < 0) return false;
  let sources;
  try { sources = JSON.parse(memory.content.slice(boundary + footer.length)); } catch { return false; }
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
