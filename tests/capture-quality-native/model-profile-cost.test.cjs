const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { metadataMemoryIO } = require('./metadata-memory-io.cjs');
const { projectModel } = require('./model-profile.cjs');
const { validateProfile } = require('./approval.cjs');
const { prepareAuthorizedInputs } = require('./authorized-inputs.cjs');

const cost = { input: 0, output: 2, cache_read: 0, cache_write: -1,
  context_over_200k: { input: 1, output: 4, cache_read: 0, cache_write: 3 } };
const destinations = ['https://provider.invalid/responses'];
function profile(model) {
  return { model: 'openai-b1/gpt-6.1-sol', enabled_providers: ['openai-b1'], provider: { 'openai-b1': {
    npm: '@ai-sdk/openai', models: { 'gpt-6.1-sol': model },
    options: { baseURL: 'https://provider.invalid', apiKey: '{file:/synthetic/never-open}' } } } };
}

for (const nested of [false, true]) {
  test(`source cost projection strips ${nested ? 'nested' : 'ordinary'} extras without getter access`, () => {
    const input = { cost: structuredClone(cost) }; let accesses = 0;
    const target = nested ? input.cost.context_over_200k : input.cost;
    Object.defineProperty(target, 'ignored', { enumerable: true, get() { accesses++; throw new Error('unexpected_extra_access'); } });
    const result = projectModel(input);
    assert.deepEqual(result, { cost });
    assert.equal(accesses, 0);
    assert.equal(Object.hasOwn(target, 'ignored'), true);
    result.cost.context_over_200k.input = 99;
    assert.equal(input.cost.context_over_200k.input, 1);
  });

  test(`final raw profile rejects ${nested ? 'nested' : 'ordinary'} cost extras before getter access`, () => {
    const input = { cost: structuredClone(cost) }; let accesses = 0;
    const target = nested ? input.cost.context_over_200k : input.cost;
    Object.defineProperty(target, 'ignored', { enumerable: true, get() { accesses++; throw new Error('unexpected_extra_access'); } });
    assert.throws(() => validateProfile(profile(input), destinations), { code: 'profile_model_transport_override' });
    assert.equal(accesses, 0);
    assert.equal(Object.hasOwn(target, 'ignored'), true);
  });

  test(`final JSON profile rejects ${nested ? 'nested' : 'ordinary'} cost reference extras without mutation`, () => {
    const input = profile({ cost: structuredClone(cost) });
    const declared = input.provider['openai-b1'].models['gpt-6.1-sol'].cost;
    (nested ? declared.context_over_200k : declared).ignored = '{file:/synthetic/never-read}';
    const bytes = JSON.stringify(input);
    assert.throws(() => validateProfile(input, destinations), { code: 'profile_model_transport_override' });
    assert.equal(JSON.stringify(input), bytes);
  });
}

for (const input of [{ input: 0, output: 0 }, { input: -0, output: -2, cache_write: 0 },
  { output: 0, input: 1, context_over_200k: { output: -0, input: 0 } }]) {
  test('cost finite values, optional absence and zero presence survive projection', () => {
    assert.deepEqual(projectModel({ cost: input }), { cost: input });
  });
}

const malformed = [null, [], false, {}, { input: 0 }, { output: 0 },
  ...[undefined, null, false, '', NaN, Infinity, -Infinity].map((input) => ({ input, output: 0 })),
  ...[undefined, null, false, NaN, Infinity].map((cache_read) => ({ input: 0, output: 0, cache_read })),
  { input: 0, output: 0, cache_write: false }];
for (const [index, value] of malformed.entries()) {
  for (const nested of [false, true]) test(`malformed declared cost ${index} at ${nested ? 'nested' : 'ordinary'} level fails`, () => {
    const input = nested ? { input: 0, output: 0, context_over_200k: value } : value;
    assert.throws(() => projectModel({ cost: input }), { code: 'model_profile_unsupported' });
    assert.throws(() => validateProfile(profile({ cost: input }), destinations), { code: 'profile_model_transport_override' });
  });
}

test('final canonical comparison accepts reordered known model and nested cost keys', () => {
  const input = profile({ variants: { high: { disabled: false, reasoningEffort: 'high' } }, reasoning: false,
    cost: { context_over_200k: { cache_write: 3, output: 4, cache_read: 0, input: 1 },
      cache_write: -1, output: 2, cache_read: 0, input: 0 }, id: 'gpt-6.1-sol' });
  const bytes = JSON.stringify(input);
  assert.equal(validateProfile(input, destinations), 'openai-b1/gpt-6.1-sol');
  assert.equal(JSON.stringify(input), bytes);
});

test('helper writes canonical cost metadata from synthetic source extras without credential copying', () => {
  const root = '/synthetic';
  const request = { sourceConfig: path.join(root, 'source.json'), inputDirectory: path.join(root, 'inputs'),
    canaryRoot: path.join(root, 'canary'), providerID: 'openai-b1', modelID: 'gpt-6.1-sol',
    sdk: '@ai-sdk/openai', baseURL: 'https://provider.invalid', providerDestinations: destinations };
  const declared = { id: 'gpt-6.1-sol', reasoning: false, cost: structuredClone(cost),
    variants: { high: { disabled: false } } };
  const source = profile(structuredClone(declared));
  const sourceCost = source.provider['openai-b1'].models[request.modelID].cost;
  sourceCost.ignored = '{file:/synthetic/never-read}';
  sourceCost.context_over_200k.ignored = '{env:SYNTHETIC_NEVER_READ}';
  const sourceBytes = JSON.stringify(source);
  const { io, opens, reads, nodes, descriptors } = metadataMemoryIO(request.sourceConfig, sourceBytes);
  const prepared = prepareAuthorizedInputs(request, { ...request, authorized: true,
    mode: 'credential-materialization-only', consent: 'fresh-explicit-credential-materialization' }, io);
  const emitted = JSON.parse(io.readFileSync(prepared.profileRef, 'utf8'));
  assert.deepEqual(emitted.provider['openai-b1'].models[request.modelID], declared);
  assert.equal(validateProfile(emitted, destinations), 'openai-b1/gpt-6.1-sol');
  assert.deepEqual(opens, [request.sourceConfig, prepared.profileRef]);
  assert.deepEqual(reads, [request.sourceConfig, prepared.profileRef]);
  assert.equal(emitted.provider['openai-b1'].options.apiKey, '{file:/synthetic/never-open}');
  assert.equal(prepared.credentialRef, '/synthetic/never-open');
  assert.deepEqual(io.readdirSync(request.inputDirectory), ['profile.json']);
  assert.equal(io.lstatSync(request.inputDirectory).mode, 0o700);
  assert.equal(io.lstatSync(prepared.profileRef).mode, 0o600);
  assert.equal(descriptors.size, 0);
  prepared.cleanup();
  assert.deepEqual([...nodes.keys()], ['/', root, request.sourceConfig]);
  assert.equal(nodes.get(request.sourceConfig).bytes, sourceBytes);
});
