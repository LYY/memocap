import { createHash } from 'node:crypto';
import { clean } from '../observed/value.js';

export const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const normalize = (text) => text.replace(/\r\n?/g, '\n');
export const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
export const byteSize = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
export const secretSafe = clean;
export const skip = (code) => ({ status: 'skip', reason: { code } });
export const truncated = (text) => /line truncated|\.\.\.output truncated\.\.\.|Full output saved to:|<bash_metadata>/i.test(text);
const sources = new WeakSet();
export const isSource = (source) => sources.has(source);
export function retainSource(source) {
  sources.add(source);
  return freeze(source);
}

export function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function quoteSpan(source, span) {
  if (!isSource(source)) return;
  if (!Number.isSafeInteger(span?.start) || !Number.isSafeInteger(span?.end) ||
      span.start < 0 || span.end <= span.start || span.end > [...source.text].length) return;
  return [...source.text].slice(span.start, span.end).join('');
}

export function resolveQuote(source, reference) {
  if (!isSource(source) || reference?.source_id !== source.source_id || reference.content_hash !== source.content_hash) return;
  const quote = quoteSpan(source, reference.span);
  if (quote !== undefined && quote === reference.quote) return quote;
}
