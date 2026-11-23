import { sourceProfile, validProfile } from './profile.js';
import { byteSize, freeze, isSource, quoteSpan } from './value.js';

const identities = new WeakSet();
export const isBundle = (bundle) => identities.has(bundle);

function ranges(text) {
  const nodes = [{ level: 0, start: 0, end: 0, parent: undefined, children: 0 }];
  const stack = [nodes[0]];
  let offset = 0;
  let fence;
  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (!fence) {
      const heading = line.match(/^(#{1,6})\s/);
      if (heading) {
        nodes.at(-1).end = offset;
        const level = heading[1].length;
        while (stack.at(-1).level >= level) stack.pop();
        const parent = stack.at(-1);
        parent.children += 1;
        const node = { level, start: offset, end: 0, parent, children: 0 };
        nodes.push(node);
        stack.push(node);
      }
    }
    offset += [...line].length + 1;
  }
  if (fence) return [];
  nodes.at(-1).end = [...text].length;
  return nodes.filter((node) => node.children === 0).map((node) => {
    const context = [];
    for (let parent = node.parent; parent; parent = parent.parent) context.push(parent);
    const otherSections = nodes.filter((section) => section !== node && !context.includes(section));
    return [node, ...context, ...otherSections];
  });
}

function bundlesFor(source, profile) {
  const points = [...source.text];
  const sections = source.kind === 'file_content' && /\.md$/i.test(source.pointer.locator) &&
    !/\]\[[^\]]*\]|\]\(#/u.test(source.text) ? ranges(source.text) : [[{ start: 0, end: points.length }]];
  return sections.flatMap((section) => {
    const units = section.flatMap((range, index) => {
      const raw = points.slice(range.start, range.end).join('');
      const start = range.start + [...raw].length - [...raw.trimStart()].length;
      const end = range.end - ([...raw].length - [...raw.trimEnd()].length);
      if (start >= end) return [];
      const span = { start, end };
      return [{ source_id: source.source_id, role: index === 0 ? 'section' : 'context', span,
        text: quoteSpan(source, span), content_hash: source.content_hash, pointer: source.pointer }];
    });
    if (!units.length || units.reduce((total, unit) => total + [...unit.text].length, 0) > profile.max_bundle_codepoints) return [];
    const bundle = freeze({ bundle_id: `${source.source_id}:${units[0].span.start}:${units[0].span.end}`,
      source_id: source.source_id, user_id: source.user_id, kind: source.kind, outcome: source.outcome,
      completeness: 'full_section', observed_at: source.pointer.observed_at, units,
      context_dependencies: units.slice(1).map((unit) => unit.span) });
    identities.add(bundle);
    return [bundle];
  });
}

export function sourceBundles(sources, profile = sourceProfile) {
  if (!validProfile(profile) || !Array.isArray(sources) || sources.length > profile.max_sources) {
    return freeze({ bundles: [], omitted: { input_budget: sources?.length ?? 0 } });
  }
  const valid = sources.filter(isSource);
  if (valid.reduce((total, source) => total + byteSize(source), 0) > profile.max_input_bytes) {
    return freeze({ bundles: [], omitted: { input_budget: sources.length } });
  }
  const bundles = [];
  const omitted = { untrusted: sources.length - valid.length, source_budget: 0, pool_budget: 0 };
  let bytes = 0;
  for (const source of valid.toSorted((left, right) => right.pointer.observed_at - left.pointer.observed_at)) {
    const candidates = bundlesFor(source, profile);
    if (!candidates.length) omitted.source_budget += 1;
    for (const bundle of candidates) {
      const size = byteSize(bundle);
      if (bytes + size > profile.max_input_bytes || bundles.length >= profile.max_bundles) { omitted.pool_budget += 1; continue; }
      bundles.push(bundle);
      bytes += size;
    }
  }
  return freeze({ bundles, bytes, omitted });
}
