import { limits } from './contract.js';
import { serializeCaptureProvenance } from './identity.js';
import { freeze, isSource } from './sources/value.js';

const codePoints = (text) => [...text].length;

export function captureBodyBudget(sources, bundles) {
  const sourcePoints = new Map();
  const quote = (source, span) => {
    if (!isSource(source)) return;
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
        span.start < 0 || span.end <= span.start) return;
    if (!sourcePoints.has(source)) sourcePoints.set(source, [...source.text]);
    const points = sourcePoints.get(source);
    if (span.end > points.length) return;
    return points.slice(span.start, span.end).join('');
  };
  const empty = codePoints(serializeCaptureProvenance([], []));
  const regions = new Map();
  for (const bundle of bundles) {
    const source = sources.get(bundle.source_id);
    for (const unit of bundle.units) {
      const { start, end } = unit.span;
      const key = JSON.stringify([source.source_id, start, end]);
      if (regions.has(key)) continue;
      let upper = 0;
      for (let position = start; position < end; position++) {
        const span = { start: position, end: Math.min(position + 32, end) };
        const citation = { content_hash: source.content_hash, pointer: source.pointer, span, quote: quote(source, span) };
        upper = Math.max(upper, codePoints(serializeCaptureProvenance([], [citation])) - empty);
      }
      regions.set(key, { source_id: source.source_id, span: [start, end], citation_cp_upper_bound: upper });
    }
  }
  return freeze({ version: 1, max_body_cp: limits.maxBodyCodePoints,
    fixed_cp_by_statement_count: Array.from({ length: 4 }, (_, index) => 2 * index +
      codePoints(serializeCaptureProvenance(Array(index + 1).fill(2 * limits.maxBodyCodePoints), []))),
    reference_regions: [...regions.values()] });
}
