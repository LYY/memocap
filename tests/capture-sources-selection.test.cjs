const assert = require('node:assert/strict');
const test = require('node:test');
const { readObservation, commandObservation } = require('./capture-source-host/synthetic.cjs');
const load = () => import('../plugin/capture/sources.js');
const source = (api, text, index = 0, command = false) => {
  const observation = command ? commandObservation(text) : readObservation(text);
  observation.part.id = `part_${index}`;
  observation.part.callID = `call_${index}`;
  observation.observed_at += index;
  if (!command && text.startsWith('#')) {
    observation.part.state.input.filePath = '/synthetic/alpha.md';
    observation.part.state.output = observation.part.state.output.replaceAll('/synthetic/alpha.js', '/synthetic/alpha.md');
    observation.part.state.metadata.display.path = '/synthetic/alpha.md';
  }
  return api.adaptSource(observation).source;
};

test('numbered fenced leaf keeps parent conditions and tail beta prohibition', async () => {
  const api = await load();
  const text = '# Alpha only\n\nApproval required.\n\n## Verify\n\n1. Start docs/alpha.md.\n\n```sh\nverify alpha\n```\n\nNever use for beta.\n\n## Unrelated\n\nOther procedure.';
  const envelope = source(api, text);
  const bundles = api.sourceBundles([envelope]);
  const result = api.selectBundles(bundles.bundles, { user_id: 'user', text: 'docs/alpha.md' });
  const selected = result.bundles[0];
  assert.equal(selected.units.length, 3);
  assert.ok(selected.units[0].text.includes('Never use for beta.'));
  assert.ok(selected.units[1].text.includes('Approval required.'));
  for (const unit of selected.units) assert.equal(api.quoteSpan(envelope, unit.span), unit.text);
  assert.deepEqual(selected.context_dependencies, selected.units.slice(1).map((unit) => unit.span));
});

test('matching verification after twelve unrelated units is selected with full tail restriction', async () => {
  const api = await load();
  const sources = Array.from({ length: 12 }, (_, index) => source(api, `noise ${index}`, index));
  sources.push(source(api, '# Verify alpha\n\n1. Check alpha.\n\nNever use for beta.', 12));
  sources.push(source(api, 'alpha independently verified\n', 13, true));
  const result = api.selectBundles(api.sourceBundles(sources).bundles, { user_id: 'user', text: 'verify alpha' });
  assert.equal(result.bundles[0].source_id, 'part_13');
  assert.ok(result.bundles.some((bundle) => bundle.source_id === 'part_12' && bundle.units[0].text.includes('Never use for beta.')));
  assert.equal(result.units <= 12, true);
});

test('overbudget dependency bundle is omitted whole instead of keeping its route prefix', async () => {
  const api = await load();
  const envelope = source(api, '# Alpha\n\nApproval required.\n\n## Verify\n\n1. Verify alpha.\nNever use for beta.');
  const bundles = api.sourceBundles([envelope]).bundles;
  const result = api.selectBundles(bundles, { user_id: 'user', text: 'Verify alpha' }, { ...api.sourceProfile, max_selected_units: 1 });
  assert.deepEqual(result.bundles, []);
  assert.equal(result.omitted.bundle_budget, 1);
});

test('long section and unknown fragments cannot be salvaged by prefix or forged envelope', async () => {
  const api = await load();
  const envelope = source(api, `# Alpha\n\n${'condition '.repeat(100)}\nNever use for beta.`);
  assert.deepEqual(api.sourceBundles([envelope]).bundles, []);
  assert.deepEqual(api.sourceBundles([{ ...envelope, completeness: 'fragment' }]).bundles, []);
  assert.deepEqual(api.selectBundles([{ source_id: 'fake', units: [] }], { user_id: 'user', text: 'alpha' }).bundles, []);
});

test('input cap rejects the entire oversized collection without first-N selection', async () => {
  const api = await load();
  const sources = Array.from({ length: 65 }, (_, index) => source(api, `alpha ${index}`, index));
  const result = api.sourceBundles(sources);
  assert.deepEqual(result.bundles, []);
  assert.equal(result.omitted.input_budget, 65);
});

test('secret sibling rejects the entire file before section extraction', async () => {
  const api = await load();
  const observation = readObservation('# Alpha\n\nVerify alpha.\n\n## Credentials\n\npassword=synthetic-value');
  assert.equal(api.adaptSource(observation).status, 'skip');
});

test('selection counts dependency bytes and isolates the current user', async () => {
  const api = await load();
  const pool = api.sourceBundles([source(api, '# Alpha\n\nApproval required.\n\n## Verify\n\nVerify alpha. Never use for beta.')]);
  const request = { user_id: 'user', text: 'Verify alpha' };
  const selected = api.selectBundles(pool.bundles, request);
  assert.equal(selected.bytes, Buffer.byteLength(JSON.stringify(selected.bundles[0])));
  assert.deepEqual(api.selectBundles(pool.bundles, request, { ...api.sourceProfile, max_selected_bytes: selected.bytes - 1 }).bundles, []);
  assert.deepEqual(api.selectBundles(pool.bundles, { ...request, user_id: 'other' }).bundles, []);
});

test('fenced heading text is not a section boundary and open fences are omitted', async () => {
  const api = await load();
  const text = '# Alpha\n\n```sh\n# not a heading\nverify alpha\n```\nNever use for beta.';
  const bundles = api.sourceBundles([source(api, text)]).bundles;
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].units[0].text, text);
  assert.deepEqual(api.sourceBundles([source(api, '# Alpha\n\n```sh\nverify alpha')]).bundles, []);
});

test('a sibling section cannot silently lose a condition applying to the selected route', async () => {
  const api = await load();
  const text = '# Release\n\n## Entry\n\nRun alpha.\n\n## Applicability\n\nApproval required. Never use for beta.';
  const pool = api.sourceBundles([source(api, text)]);
  const selection = api.selectBundles(pool.bundles, { user_id: 'user', text: 'Run alpha' });
  assert.ok(selection.bundles[0].units.some((unit) => unit.text.includes('Never use for beta.')));
});

for (const request of ['请帮我配置alpha发布流程', '请帮我配置发布流程', 'Prepare the rollout procedure']) {
  test(`observed route remains eligible across task wording: ${request}`, async () => {
    const api = await load();
    const envelope = source(api, '# Alpha release\nUse release.sh for alpha only.\nApproval required. Do not use for beta.');
    const pool = api.sourceBundles([envelope]);
    const selected = api.selectBundles(pool.bundles, { user_id: 'user', text: request });
    assert.deepEqual(selected.bundles, pool.bundles);
    assert.equal(selected.bundles[0].source_id, envelope.source_id);
    for (const unit of selected.bundles[0].units) assert.equal(api.quoteSpan(envelope, unit.span), unit.text);
  });
}

test('lexical overlap ranks eligible evidence before newer noise without authorizing another user', async () => {
  const api = await load();
  const route = source(api, 'Alpha requires approval; beta is prohibited.', 0);
  const noise = source(api, 'Unrelated observed output.', 1);
  const foreign = source(api, 'alpha release verified', 2);
  const observation = readObservation('alpha release verified');
  observation.user_id = 'foreign';
  observation.part.id = foreign.source_id;
  const pool = api.sourceBundles([route, noise, api.adaptSource(observation).source]).bundles;
  const selection = api.selectBundles(pool, { user_id: 'user', text: '请配置alpha发布' }, { ...api.sourceProfile, max_selected_units: 1 });
  assert.deepEqual(selection.bundles.map((bundle) => bundle.source_id), [route.source_id]);
  assert.equal(selection.omitted.bundle_budget, 1);
});

test('prior task evidence needs explicit prior user eligibility even without word overlap', async () => {
  const api = await load();
  const pool = api.sourceBundles([source(api, '# Alpha\nApproval required. Never use for beta.')]).bundles;
  const request = { user_id: 'followup', text: '请继续处理刚才的发布事项' };
  assert.deepEqual(api.selectBundles(pool, request).bundles, []);
  assert.deepEqual(api.selectBundles(pool, { ...request, prior_user_ids: ['user'] }).bundles, pool);
  assert.deepEqual(api.selectBundles(pool, { ...request, prior_user_ids: ['different'] }).bundles, []);
});

test('no-overlap fallback keeps whole-bundle byte boundaries and duplicate identity', async () => {
  const api = await load();
  const pool = api.sourceBundles([source(api, '# Alpha\nApproval required. Never use for beta.')]).bundles;
  const request = { user_id: 'user', text: '请处理发布流程' };
  const size = Buffer.byteLength(JSON.stringify(pool[0]));
  const exact = api.selectBundles([...pool, ...pool], request, { ...api.sourceProfile, max_selected_bytes: size });
  assert.equal(exact.bytes, size);
  assert.deepEqual(exact.bundles, pool);
  assert.equal(exact.omitted.duplicate, 1);
  assert.deepEqual(api.selectBundles(pool, request, { ...api.sourceProfile, max_selected_bytes: size - 1 }).bundles, []);
});
