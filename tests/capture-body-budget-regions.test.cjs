const test = require('node:test');
const assert = require('node:assert/strict');
const { readObservation } = require('./capture-source-host/synthetic.cjs');
const cp = (value) => [...value].length;

async function host(text, locator = '/synthetic/alpha.js', id = 'part') {
  const api = await import('../plugin/capture/sources.js');
  const observation = readObservation(text);
  observation.part.state.output = observation.part.state.output.replaceAll('/synthetic/alpha.js', locator);
  observation.part.state.input.filePath = locator;
  observation.part.state.metadata.display.path = locator;
  observation.part.id = id;
  observation.part.body_budget = { version: 900, max_body_cp: 99999 };
  const source = api.adaptSource(observation).source;
  assert.ok(source);
  const { captureSourceProfile } = await import('../plugin/capture/sources/profile.js');
  return { api, source, sources: new Map([[source.source_id, source]]), userID: 'user',
    bundles: api.sourceBundles([source], captureSourceProfile).bundles };
}

test('selected regional bounds cover every legal short quote and UTF16 statement length edge', async () => {
  const current = await host('A😀中"\\\n\t\0\u001fZ');
  const { captureBodyBudget } = await import('../plugin/capture/body-budget.js');
  const { serializeCaptureProvenance, identify } = await import('../plugin/capture/identity.js');
  const { admitCandidate } = await import('../plugin/capture/admission.js');
  const budget = captureBodyBudget(current.sources, current.bundles);
  assert.deepEqual(budget.fixed_cp_by_statement_count, [55, 62, 69, 76]);
  assert.equal(budget.max_body_cp, 1200);
  assert.equal(budget.version, 1);
  const row = budget.reference_regions[0];
  const points = [...current.source.text];
  let maximum = 0;
  for (let start = row.span[0]; start < row.span[1]; start++) {
    for (let end = start + 1; end <= row.span[1]; end++) {
      const citation = { source_id: current.source.source_id, content_hash: current.source.content_hash,
        span: { start, end }, quote: points.slice(start, end).join('') };
      if (!citation.quote.trim()) continue;
      const admitted = admitCandidate({ candidates: [{ statements: [{ text: 'Complete condition.', citations: [citation] }] }] }, current);
      assert.equal(admitted.status, 'candidate');
      const refs = admitted.candidate.citations;
      const cost = cp(serializeCaptureProvenance([], refs)) - cp(serializeCaptureProvenance([], []));
      maximum = Math.max(maximum, cost);
      assert.ok(cost <= row.citation_cp_upper_bound);
      for (const n of [1, 2, 3, 4]) for (const length of [1, 5, 9, 10, 49, 50, 99, 100, 499, 500, 999, 1000, 1190, 1200]) {
        const statements = Array.from({ length: n }, () => ({ text: '😀'.repeat(length) }));
        const size = cp(identify(statements, 'repository:fixture', refs).body);
        const upper = n * length + budget.fixed_cp_by_statement_count[n - 1] + row.citation_cp_upper_bound;
        assert.ok(size <= upper);
        if (upper <= 1200) assert.ok(size <= 1200);
      }
    }
  }
  assert.equal(row.citation_cp_upper_bound, maximum);
  assert.equal(Object.isFrozen(row), true);
  assert.equal(Object.isFrozen(row.span), true);
  assert.equal(Object.isFrozen(budget.fixed_cp_by_statement_count), true);
});

test('only selected unit CP regions contribute even at offset digit boundaries', async () => {
  const { captureBodyBudget } = await import('../plugin/capture/body-budget.js');
  const { serializeCaptureProvenance } = await import('../plugin/capture/identity.js');
  const { admitCandidate } = await import('../plugin/capture/admission.js');
  for (const start of [8, 9, 98, 99, 998, 999, 9998]) {
    const current = await host(' '.repeat(start) + '😀"\\\t\0\u001f'.repeat(7) + 'z'.repeat(36), '/synthetic/"\\\t😀/alpha.md');
    assert.equal(current.bundles.length, 1);
    const budget = captureBodyBudget(current.sources, current.bundles);
    const row = budget.reference_regions[0];
    assert.deepEqual(row.span, [start, cp(current.source.text)]);
    let maximum = 0;
    for (let offset = start; offset < row.span[1]; offset++) {
      const span = { start: offset, end: Math.min(offset + 32, row.span[1]) };
      const citation = { ...current.source, span, quote: current.api.quoteSpan(current.source, span) };
      maximum = Math.max(maximum, cp(serializeCaptureProvenance([], [citation])) - cp(serializeCaptureProvenance([], [])));
    }
    assert.equal(row.citation_cp_upper_bound, maximum);
    for (const offset of [start, start + 1]) for (const length of [1, 2, 9, 31, 32, 33, 34]) {
      const span = { start: offset, end: offset + length };
      const citation = { ...current.source, span, quote: current.api.quoteSpan(current.source, span) };
      const cost = cp(serializeCaptureProvenance([], [citation])) - cp(serializeCaptureProvenance([], []));
      assert.ok(cost <= row.citation_cp_upper_bound);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(budget)) < 4096);
    assert.ok(budget.reference_regions.length <= 12);
    const proposal = { candidates: [{ statements: [{ text: 'Condition.', citations: [{ source_id: current.source.source_id,
      content_hash: current.source.content_hash, span: current.source.span, quote: current.source.text }] }] }] };
    assert.equal(admitCandidate(proposal, current).reason.code, 'evidence_mismatch');
  }
});

test('full resolved distinct references charge twice even when compact 33 and 34 CP entries collide', async () => {
  const current = await host('A'.repeat(100), '/synthetic/'.padEnd(151, 'x'));
  const { captureBodyBudget } = await import('../plugin/capture/body-budget.js');
  const { identify, serializeCaptureProvenance } = await import('../plugin/capture/identity.js');
  const { admitCandidate } = await import('../plugin/capture/admission.js');
  const refs = [33, 34].map((end) => ({ source_id: current.source.source_id, content_hash: current.source.content_hash,
    span: { start: 0, end }, quote: 'A'.repeat(end) }));
  const candidate = (citations) => admitCandidate({ candidates: [{ statements: [{ text: 'B'.repeat(700), citations }] }] }, current).candidate;
  const repeated = candidate([refs[0], structuredClone(refs[0])]);
  const distinct = candidate(refs);
  assert.equal(repeated.citations.length, 1);
  assert.equal(distinct.citations.length, 2);
  assert.equal(serializeCaptureProvenance([], [distinct.citations[0]]), serializeCaptureProvenance([], [distinct.citations[1]]));
  assert.equal(cp(identify(distinct.statements, 'repository:fixture', distinct.citations).body), 1511);
  assert.equal(cp(identify(repeated.statements, 'repository:fixture', repeated.citations).body), 1132);
  const shifted = candidate([refs[0], { ...refs[1], span: { start: 1, end: 35 } }]);
  assert.equal(shifted.citations.length, 2);
  const budget = captureBodyBudget(current.sources, current.bundles);
  const cost = budget.reference_regions[0].citation_cp_upper_bound;
  const singleton = 1200 - budget.fixed_cp_by_statement_count[0] - cost;
  const pair = 1200 - budget.fixed_cp_by_statement_count[0] - 2 * cost - 1;
  assert.ok(singleton >= 700);
  assert.ok(pair < 700);
});

test('unused expensive selected region preserves feasible singleton capacity and dependencies', async () => {
  const cheap = await host('Keep the complete condition.');
  const expensive = await host('Other complete condition.', '/synthetic/'.padEnd(3000, 'x'), 'expensive');
  const { captureBodyBudget } = await import('../plugin/capture/body-budget.js');
  const before = captureBodyBudget(cheap.sources, cheap.bundles);
  const sources = new Map([...cheap.sources, ...expensive.sources]);
  const bundles = [...cheap.bundles, ...expensive.bundles];
  const after = captureBodyBudget(sources, bundles);
  assert.deepEqual(after.reference_regions[0], before.reference_regions[0]);
  assert.equal(after.reference_regions.length, 2);
  assert.ok(after.reference_regions[1].citation_cp_upper_bound > 1200);
  assert.equal(bundles.length, 2);
});

test('unselected escaped whitespace cannot consume a selected unit capacity or become an admitted quote', async () => {
  const current = await host('\t'.repeat(32) + 'A'.repeat(50));
  const { captureBodyBudget } = await import('../plugin/capture/body-budget.js');
  const { serializeCaptureProvenance } = await import('../plugin/capture/identity.js');
  const { admitCandidate } = await import('../plugin/capture/admission.js');
  const budget = captureBodyBudget(current.sources, current.bundles);
  assert.deepEqual(budget.reference_regions[0].span, [32, 82]);
  const citation = { source_id: current.source.source_id, content_hash: current.source.content_hash,
    span: { start: 0, end: 33 }, quote: `${'\t'.repeat(32)}A` };
  const cost = cp(serializeCaptureProvenance([], [{ ...citation, pointer: current.source.pointer }])) - cp(serializeCaptureProvenance([], []));
  assert.ok(cost > budget.reference_regions[0].citation_cp_upper_bound);
  assert.equal(admitCandidate({ candidates: [{ statements: [{ text: 'Complete condition.', citations: [citation] }] }] }, current).reason.code, 'evidence_mismatch');
});

test('maximum selected unit work yields twelve bounded metadata rows without pair expansion', async () => {
  const { captureBodyBudget } = await import('../plugin/capture/body-budget.js');
  const entries = await Promise.all(Array.from({ length: 12 }, (_, index) => host('A'.repeat(3200),
    '/synthetic/alpha.js', `source_${index}`.padEnd(128, 'x'))));
  const sources = new Map(entries.flatMap((entry) => [...entry.sources]));
  const bundles = entries.flatMap((entry) => entry.bundles);
  const before = JSON.stringify(bundles);
  const budget = captureBodyBudget(sources, bundles);
  assert.equal(budget.reference_regions.length, 12);
  assert.equal(budget.reference_regions.reduce((sum, row) => sum + row.span[1] - row.span[0], 0), 38400);
  assert.ok(Buffer.byteLength(JSON.stringify(budget)) <= 4096);
  assert.equal(JSON.stringify(bundles), before);
});

test('message pointers without lines and maximum observation times use the real serializer', async () => {
  const { adaptSource, sourceBundles } = await import('../plugin/capture/sources.js');
  const { captureBodyBudget } = await import('../plugin/capture/body-budget.js');
  const { serializeCaptureProvenance } = await import('../plugin/capture/identity.js');
  const source = adaptSource({ host_version: '1.19.3', user_id: 'user', observed_at: Number.MAX_SAFE_INTEGER,
    message: { id: 'user', role: 'user' }, part: { id: 'part', type: 'text', text: '😀"\\\n\t\0\u001fZ' } }).source;
  const budget = captureBodyBudget(new Map([[source.source_id, source]]), sourceBundles([source]).bundles);
  const serialized = serializeCaptureProvenance([], [{ ...source, quote: source.text }]);
  assert.ok(cp(serialized) - cp(serializeCaptureProvenance([], [])) <= budget.reference_regions[0].citation_cp_upper_bound);
  const persisted = JSON.parse(serialized.slice('\n\nCapture sources: '.length)).citations[0];
  assert.equal(persisted.observed_at, Number.MAX_SAFE_INTEGER);
  assert.equal(persisted.type, 'message_part');
  assert.equal(Object.hasOwn(persisted, 'lines'), false);
});

test('complete budget preserves ordered unique regions for repeated Unicode source selections', async () => {
  const current = await host('😀"\\\t\0\u001f中'.repeat(20));
  const other = await host('B'.repeat(50), '/synthetic/other.js', 'other');
  const { captureBodyBudget } = await import('../plugin/capture/body-budget.js');
  const { serializeCaptureProvenance } = await import('../plugin/capture/identity.js');
  const spans = [{ start: 9, end: 10 }, { start: 10, end: 42 }, { start: 99, end: 132 }];
  const bundles = [{ ...current.bundles[0], units: spans.map((span) => ({ span })) },
    ...other.bundles, { ...current.bundles[0], units: [{ span: spans[1] }, { span: spans[0] }] }];
  const selected = spans.map((span) => ({ source: current.source, span }));
  selected.push({ source: other.source, span: other.bundles[0].units[0].span });
  const expected = { version: 1, max_body_cp: 1200, fixed_cp_by_statement_count: [55, 62, 69, 76],
    reference_regions: selected.map(({ source, span: region }) => {
      const costs = Array.from({ length: region.end - region.start }, (_, offset) => {
        const span = { start: region.start + offset, end: Math.min(region.start + offset + 32, region.end) };
        const quote = current.api.quoteSpan(source, span);
        return cp(serializeCaptureProvenance([], [{ ...source, span, quote }])) - cp(serializeCaptureProvenance([], []));
      });
      return { source_id: source.source_id, span: [region.start, region.end], citation_cp_upper_bound: Math.max(...costs) };
    }) };
  const before = JSON.stringify(bundles);
  const budget = captureBodyBudget(new Map([...current.sources, ...other.sources]), bundles);
  assert.deepEqual(budget, expected);
  assert.equal(JSON.stringify(bundles), before);
  for (const entry of [budget, budget.reference_regions, budget.fixed_cp_by_statement_count,
    ...budget.reference_regions.flatMap((row) => [row, row.span])]) assert.equal(Object.isFrozen(entry), true);
});

test('budget cannot serialize a forged source or a noninteger or out-of-range quote window', async () => {
  const current = await host('😀'.repeat(40));
  const { captureBodyBudget } = await import('../plugin/capture/body-budget.js');
  for (const [source, span] of [
    [{ ...current.source }, { start: 0, end: 40 }],
    [current.source, { start: -1, end: 10 }],
    [current.source, { start: 0.5, end: 10 }],
    [current.source, { start: 0, end: 10.5 }],
    [current.source, { start: 39, end: 41 }],
  ]) {
    const bundles = [{ ...current.bundles[0], units: [{ span }] }];
    assert.throws(() => captureBodyBudget(new Map([[source.source_id, source]]), bundles), TypeError);
  }
});

test('source decoding is shared across regions only within one budget invocation', async (t) => {
  const current = await host('😀中"\\'.repeat(30));
  const { captureBodyBudget } = await import('../plugin/capture/body-budget.js');
  const bundles = [{ ...current.bundles[0], units: [
    { span: { start: 0, end: 50 } }, { span: { start: 50, end: 120 } }, { span: { start: 0, end: 50 } },
  ] }];
  const iterator = String.prototype[Symbol.iterator];
  let decodings = 0;
  t.mock.method(String.prototype, Symbol.iterator, function () {
    if (String(this) === current.source.text) decodings++;
    return Reflect.apply(iterator, this, []);
  });
  const first = captureBodyBudget(current.sources, bundles);
  assert.equal(decodings, 1);
  decodings = 0;
  const second = captureBodyBudget(current.sources, bundles);
  assert.equal(decodings, 1);
  assert.deepEqual(second, first);
});
