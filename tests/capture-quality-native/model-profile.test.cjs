const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { metadataMemoryIO } = require('./metadata-memory-io.cjs');
const { projectModel } = require('./model-profile.cjs');
const { prepareAuthorizedInputs, inputBlockedReason } = require('./authorized-inputs.cjs');
const { validateProfile } = require('./approval.cjs');

const behavior = {
  id: 'gpt-6.1-sol', name: 'Synthetic model', family: 'gpt', release_date: '2026-01-01',
  attachment: false, reasoning: true, temperature: false, tool_call: true, experimental: false, status: 'active',
  reasoning_options: [{ type: 'effort', values: [null, 'none', 'high', 'xhigh'] }, { type: 'toggle' },
    { type: 'budget_tokens', min: 0, max: 1000 }], interleaved: { field: 'reasoning_content' },
  cost: { input: 0, output: 2, cache_read: 0, cache_write: 1,
    context_over_200k: { input: 1, output: 4, cache_read: 0, cache_write: 2 } },
  limit: { context: 1000, input: 0, output: 0 }, modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  options: { reasoningEffort: 'high', reasoningSummary: 'auto', textVerbosity: 'low',
    include: ['reasoning.encrypted_content'], parallelToolCalls: false, store: false },
  variants: { none: { reasoningEffort: 'none' }, low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' },
    high: { reasoningEffort: 'high', disabled: false }, off: { disabled: true } },
};

test('pure projection preserves actual declared behavior without defaults or input mutation', () => {
  const input = structuredClone(behavior);
  const result = projectModel(input);
  assert.deepEqual(result, behavior);
  result.options.include.push('reasoning.encrypted_content');
  assert.deepEqual(input, behavior);
  assert.deepEqual(projectModel({}), {});
});

test('unknown top-level values are never inspected even when access would read a file', () => {
  const input = { reasoning: false }; let reads = 0;
  for (const key of ['knowledge', 'last_updated', 'open_weights', 'apiKey']) {
    Object.defineProperty(input, key, { enumerable: true, get() { reads++; throw new Error('SYNTHETIC_SECRET'); } });
  }
  assert.deepEqual(projectModel(input), { reasoning: false });
  assert.equal(reads, 0);
});

for (const input of [{ interleaved: false }, { interleaved: 'reasoning_text' },
  { reasoning_options: [{ type: 'effort', values: [null] }] }, { options: {}, variants: {}, headers: {} },
  { modalities: { input: [], output: [] } }, { name: '', family: '', release_date: '' },
  { reasoning_options: [{ type: 'budget_tokens', min: 0, max: 0 }] }]) {
  test('supported empty, false, zero and nullable effort values retain presence', () => {
    assert.deepEqual(projectModel(input), input);
  });
}

const invalid = [null, [], false, { id: 'other' }, { id: null }, { id: undefined },
  { reasoning: 0 }, { attachment: null }, { temperature: '' }, { tool_call: 'true' }, { experimental: 1 },
  { name: '\ud800' }, { family: '\udfff' }, { name: '\u0000' }, { name: '{file:/never}' },
  { release_date: '{env:NEVER_READ}' }, { name: 'sk-SYNTHETIC_SECRET' }, { status: 'unknown' },
  { cost: {} }, { cost: { input: 0, output: Infinity } },
  { cost: { input: 0, output: 0, context_over_200k: { input: 0 } } },
  { limit: {} }, { limit: { context: NaN, output: 0 } }, { limit: { context: 1, output: null } },
  { modalities: null }, { modalities: { input: ['binary'] } }, { modalities: { output: 'text' } },
  { reasoning_options: null }, { reasoning_options: [{ type: 'effort', values: [false] }] },
  { reasoning_options: [{ type: 'effort', values: ['{env:NEVER_READ}'] }] },
  { reasoning_options: [{ type: 'budget_tokens', min: Infinity }] }, { reasoning_options: [{ type: 'other' }] },
  { interleaved: null }, { interleaved: '{file:/never}' }, { interleaved: { field: 'custom' } },
  { provider: { api: 'https://elsewhere.invalid' } }, { provider: { npm: '@ai-sdk/other' } }, { provider: null },
  { headers: { Authorization: 'SYNTHETIC_SECRET' } }, { headers: null }, { options: null },
  { options: { reasoningEffort: null } }, { options: { parallelToolCalls: 0 } }, { options: { store: null } },
  { options: { reasoningSummary: 'SYNTHETIC_SECRET' } }, { options: { textVerbosity: '{file:/never}' } },
  { options: { include: ['SYNTHETIC_SECRET'] } }, { options: { include: [null] } },
  { options: { apiKey: 'SYNTHETIC_SECRET' } }, { options: { baseURL: 'https://elsewhere.invalid' } },
  { options: { nested: { reasoningEffort: 'high' } } }, { variants: null }, { variants: { high: null } },
  { variants: { high: { disabled: null } } }, { variants: { high: { disabled: 0 } } },
  { variants: { high: { headers: {} } } }, { variants: { high: { options: { apiKey: 'SYNTHETIC_SECRET' } } } },
  { variants: { '{env:NEVER_READ}': {} } }, { variants: { high: { unknown: false } } },
];
for (const [index, input] of invalid.entries()) test(`invalid or unsupported model is categorically refused ${index}`, () => {
  assert.throws(() => projectModel(input), (error) => {
    assert.equal(error.message.includes('SYNTHETIC_SECRET'), false);
    return error.code === 'model_profile_unsupported';
  });
});

test('profile boundary rejects unknown top-level keys without accessing their values', () => {
  const model = { reasoning: true }; let accesses = 0;
  Object.defineProperty(model, 'knowledge', { enumerable: true, get() { accesses++; throw new Error('SYNTHETIC_SECRET'); } });
  const profile = { model: 'openai-b1/gpt-6.1-sol', enabled_providers: ['openai-b1'],
    provider: { 'openai-b1': { npm: '@ai-sdk/openai', models: { 'gpt-6.1-sol': model },
      options: { apiKey: '{file:/never-open}', baseURL: 'https://provider.invalid' } } } };
  assert.throws(() => validateProfile(profile, ['https://provider.invalid/responses']),
    { code: 'profile_model_transport_override' });
  assert.equal(accesses, 0);
});

test('helper-produced projected profile accepts source extras without following native credential references', () => {
  const root = '/synthetic';
  const request = { sourceConfig: path.join(root, 'source.json'), inputDirectory: path.join(root, 'inputs'),
    canaryRoot: path.join(root, 'canary'), providerID: 'openai-b1', modelID: 'gpt-6.1-sol',
    sdk: '@ai-sdk/openai', baseURL: 'https://provider.invalid', providerDestinations: ['https://provider.invalid/responses'] };
  const credential = path.join(root, 'never-open');
  const declared = { id: request.modelID, reasoning: false, variants: { high: { disabled: false } } };
  const source = JSON.stringify({ provider: { 'openai-b1': { npm: request.sdk,
    models: { [request.modelID]: { ...declared, ignored_loader_field: '{file:/synthetic/unapproved-source}' } },
    options: { apiKey: `{file:${credential}}`, baseURL: request.baseURL } } } });
  const { io, opens, reads, nodes, descriptors } = metadataMemoryIO(request.sourceConfig, source);
  const prepared = prepareAuthorizedInputs(request, { ...request, authorized: true,
    mode: 'credential-materialization-only', consent: 'fresh-explicit-credential-materialization' }, io);
  const projected = JSON.parse(io.readFileSync(prepared.profileRef, 'utf8'));
  assert.equal(validateProfile(projected, request.providerDestinations), 'openai-b1/gpt-6.1-sol');
  assert.deepEqual(projected.provider['openai-b1'].models[request.modelID], declared);
  assert.deepEqual(opens, [request.sourceConfig, prepared.profileRef]);
  assert.deepEqual(reads, [request.sourceConfig, prepared.profileRef]);
  assert.equal(projected.provider['openai-b1'].options.apiKey, `{file:${credential}}`);
  assert.equal(prepared.credentialRef, credential);
  assert.deepEqual(io.readdirSync(request.inputDirectory), ['profile.json']);
  assert.equal(io.lstatSync(request.inputDirectory).mode, 0o700);
  assert.equal(io.lstatSync(prepared.profileRef).mode, 0o600);
  assert.equal(descriptors.size, 0);
  prepared.cleanup();
  assert.deepEqual([...nodes.keys()], ['/', root, request.sourceConfig]);
  assert.equal(nodes.get(request.sourceConfig).bytes, source);
});

test('unsupported nested behavior blocks before credential validation, target read or materialization and consumes gate', () => {
  const root = '/synthetic';
  const request = { sourceConfig: path.join(root, 'source.json'), inputDirectory: path.join(root, 'inputs'),
    canaryRoot: path.join(root, 'canary'), providerID: 'openai-b1', modelID: 'gpt-6.1-sol',
    sdk: '@ai-sdk/openai', baseURL: 'https://provider.invalid', providerDestinations: ['https://provider.invalid/responses'] };
  const source = JSON.stringify({ provider: { 'openai-b1': { npm: request.sdk,
    models: { 'gpt-6.1-sol': { variants: { high: { apiKey: 'SYNTHETIC_SECRET' } } } },
    options: { apiKey: '{env:NEVER_READ}', baseURL: request.baseURL } } } });
  const gate = { ...request, authorized: true, mode: 'credential-materialization-only',
    consent: 'fresh-explicit-credential-materialization' };
  const { io, opens, reads, mutations, nodes, descriptors } = metadataMemoryIO(request.sourceConfig, source);
  assert.throws(() => prepareAuthorizedInputs(request, gate, io), (error) =>
    inputBlockedReason(error) === 'source_model_metadata_unsupported');
  assert.deepEqual(opens, [request.sourceConfig]); assert.deepEqual(mutations, []);
  assert.throws(() => prepareAuthorizedInputs(request, gate, io), { code: 'credential_materialization_consent_required' });
  assert.deepEqual(opens, [request.sourceConfig]);
  assert.deepEqual(reads, [request.sourceConfig]);
  assert.deepEqual(mutations, []);
  assert.equal(descriptors.size, 0);
  assert.deepEqual([...nodes.keys()], ['/', root, request.sourceConfig]);
});
