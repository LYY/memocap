const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { approve, hash, implementationFingerprint, validateProfile } = require('./approval.cjs');
const { memoryIO } = require('./fakes.cjs');
const { joinReadRoute, receipt, maintenance, usage } = require('./projection.cjs');
const { materialize } = require('./support.cjs');
const { fixtures } = require('./controller.cjs');

function profile() {
  return { model: 'openai-b1/gpt-6.1-sol', enabled_providers: ['openai-b1'],
    provider: { 'openai-b1': { npm: '@ai-sdk/openai-compatible', models: { 'gpt-6.1-sol': {} },
    options: { baseURL: 'https://provider.invalid', apiKey: '{file:/native-only-reference}' } } } };
}

test('raw JSON profile refuses ignored model source references without mutating input or exposing values', () => {
  const value = profile();
  value.provider['openai-b1'].models['gpt-6.1-sol'] = {
    id: 'gpt-6.1-sol', ignored_loader_field: '{file:/synthetic/unapproved-source}',
  };
  const bytes = JSON.stringify(value);
  assert.throws(() => validateProfile(value, ['https://provider.invalid/responses']), (error) => {
    assert.equal(error.message.includes('/synthetic/unapproved-source'), false);
    return error.code === 'profile_model_transport_override';
  });
  assert.equal(JSON.stringify(value), bytes);
});

test('profile admits declared reasoning controls and five configured variants', () => {
  const value = profile();
  value.provider['openai-b1'].models['gpt-6.1-sol'] = {
    reasoning_options: [{ type: 'effort', values: [null, 'low', 'high'] }],
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: { none: { reasoningEffort: 'none' }, low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' }, off: { disabled: false } },
  };
  assert.equal(validateProfile(value, ['https://provider.invalid/responses']), value.model);
});

for (const model of [{ reasoning: null }, { modalities: { input: ['invalid'] } },
  { limit: { context: 1 } }, { cost: { input: 0 } }, { options: { apiKey: 'SYNTHETIC_SECRET' } }]) {
  test('profile rejects malformed or unsupported declared model behavior', () => {
    const value = profile(); value.provider['openai-b1'].models['gpt-6.1-sol'] = model;
    assert.throws(() => validateProfile(value, ['https://provider.invalid/responses']));
  });
}

test('conventional schema metadata leaves the exact model-only profile runnable', () => {
  assert.equal(validateProfile({ ...profile(), $schema: 'https://opencode.ai/config.json' },
    ['https://provider.invalid/responses']), 'openai-b1/gpt-6.1-sol');
});

for (const models of [undefined, {}, { other: {} }]) {
  test('profile must register its custom selected model without relying on catalog discovery', () => {
    const value = profile(); value.provider['openai-b1'].models = models;
    assert.throws(() => validateProfile(value, ['https://provider.invalid/responses']), { code: 'profile_model_registration_required' });
  });
}

test('profile restricts enabled discovery to its sole approved provider', () => {
  const value = profile(); delete value.enabled_providers;
  assert.throws(() => validateProfile(value, ['https://provider.invalid/responses']), { code: 'profile_is_not_model_only' });
});

for (const metadata of [null, {}, 'https://elsewhere.invalid/config.json', '{file:/never-open}']) {
  test('schema metadata cannot introduce a new source or substitution', () => {
    assert.throws(() => validateProfile({ ...profile(), $schema: metadata }, ['https://provider.invalid/responses']));
  });
}

function approvalFake() {
  const fake = memoryIO();
  const io = { ...fs, ...fake, readFileSync: (file, ...args) => fake.files.has(file) ? fake.readFileSync(file) : fs.readFileSync(file, ...args) };
  const input = { enabled: true, profileRef: '/offline-model-profile', credentialRef: 'opaque-native-reference',
    consent: 'quality-native-canary-v1:fresh-bounded-runtime', providerDestinations: ['https://provider.invalid/responses'],
    authDestinations: [], existingCapability: true, approvalRef: '/offline-runtime-approval', attemptFile: '/offline-attempt', privateRoot: '/offline-owned' };
  const manifest = { kind: 'quality-native-runtime-v2', authorized: true, batch: 'offline-test',
    implementation: implementationFingerprint(), private_root: input.privateRoot, attempt_file: input.attemptFile,
    credential_reference: input.credentialRef, existing_capability: true,
    preload_source_audit: 'approved_for_exact_host_hash', egress_policy_reviewed: true, preflight_loopback_only: true,
    provider_destinations: input.providerDestinations, auth_destinations: [], profile_sha256: hash(JSON.stringify(profile())) };
  for (const field of ['host', 'native', 'sandbox', 'policy', 'preflight_policy']) {
    fake.files.set(`/offline-${field}`, `synthetic ${field}`);
    manifest[field] = { path: `/offline-${field}`, sha256: hash(`synthetic ${field}`),
      ...(field === 'host' ? { version: '1.19.5' } : field === 'native' ? { version: '0.7.0' } : {}) };
  }
  fake.files.set(input.profileRef, JSON.stringify(profile()));
  const save = () => fake.files.set(input.approvalRef, JSON.stringify(manifest));
  save();
  return { fake, io, input, manifest, save };
}

test('fresh approval binds exact implementation, isolated paths, binary bytes and native references', () => {
  const fake = approvalFake();
  const admitted = approve(fake.input, fake.io);
  assert.equal(admitted.model.modelID, 'gpt-6.1-sol');
  assert.equal(fake.fake.files.has(fake.input.attemptFile), false);
});

for (const [field, value, reason] of [['authorized', false, 'runtime_approval_mismatch'],
  ['implementation', 'different', 'runtime_approval_mismatch'], ['auth_destinations', null, 'runtime_approval_mismatch'],
  ['preflight_loopback_only', false, 'runtime_approval_mismatch'],
  ['preload_source_audit', null, 'runtime_approval_mismatch']]) {
  test(`approval refuses altered ${field} without native setup`, () => {
    const fake = approvalFake(); fake.manifest[field] = value; fake.save();
    assert.throws(() => approve(fake.input, fake.io), { code: reason });
    assert.equal(fake.fake.files.has(fake.input.privateRoot), false);
  });
}

test('consumed attempts and altered runtime artifacts refuse before profile loading', () => {
  const fake = approvalFake();
  fake.fake.files.delete(fake.input.profileRef);
  fake.fake.files.set(fake.input.attemptFile, 'consumed');
  assert.throws(() => approve(fake.input, fake.io), { code: 'attempt_consumed' });
  fake.fake.files.delete(fake.input.attemptFile);
  fake.fake.files.set(fake.manifest.host.path, 'altered binary');
  assert.throws(() => approve(fake.input, fake.io), { code: 'runtime_artifact_mismatch' });
});

test('model-only parsing rejects mixed configuration, inline credentials and unrelated secondary models', () => {
  assert.throws(() => validateProfile({ ...profile(), plugin: [] }, ['https://provider.invalid/responses']),
    { code: 'profile_is_not_model_only' });
  assert.throws(() => validateProfile({ ...profile(), mcp: {} }, ['https://provider.invalid/responses']),
    { code: 'profile_is_not_model_only' });
  const inline = profile(); inline.provider['openai-b1'].options.apiKey = 'synthetic-inline-key';
  assert.throws(() => validateProfile(inline, ['https://provider.invalid/responses']), { code: 'native_file_credential_reference_required' });
  assert.throws(() => validateProfile({ ...profile(), small_model: 'other/model' }, ['https://provider.invalid/responses']),
    { code: 'profile_secondary_model' });
  const override = profile(); override.provider['openai-b1'].models = { 'gpt-6.1-sol': { provider: { npm: 'other-transport' } } };
  assert.throws(() => validateProfile(override, ['https://provider.invalid/responses']), { code: 'profile_model_transport_override' });
});

function joined() {
  return require('./join-fakes.cjs').joined();
}

test('read-route joins exact real-identity shaped traces but still gives no automatic quality credit', () => {
  const fake = joined();
  const result = joinReadRoute(fake);
  assert.equal(result.status, 'native_join_verified_adjudication_pending');
  assert.equal(result.quality_credit, false);
  fake.events[0].packet.sources[0].call_id = 'different-call';
  assert.equal(joinReadRoute(fake).status, 'seam_not_reached');
});

test('unrelated ask, operation or independent readback never satisfies the join', () => {
  for (const mutate of [(fake) => { fake.events[2].session = 'unrelated'; },
    (fake) => { fake.events[3].receipt = { operation_id: 'unrelated' }; },
    (fake) => { fake.events[6].call = 'unrelated'; },
    (fake) => { fake.events[4].receipt.records = [{ ...fake.events[4].receipt.records[0], tags_hash: 'changed' }]; }]) {
    const fake = joined(); mutate(fake);
    assert.equal(joinReadRoute(fake).status, 'seam_not_reached');
  }
});

test('support bindings require the selected complete bundle, native source identity and exact code-point span', () => {
  const { contract } = fixtures();
  const challenge = contract.counterfactuals.find((item) => item.name === 'drop_conditions');
  const binding = contract.bindings.dropped_short;
  const source = { source_id: 'native-source', user_id: 'native-user', completeness: 'full', content_hash: binding.content_hash,
    text: 'For alpha, start at docs/alpha.md. Approval required. Never use for beta.' };
  const packet = { sources: [source], bundles: [{ source_id: source.source_id, user_id: source.user_id,
    units: [{ content_hash: source.content_hash, span: { start: 0, end: 73 } }] }] };
  assert.equal(materialize(challenge, contract, packet).candidates[0].statements[0].citations[0].source_id, 'native-source');
  packet.bundles[0].units[0].span.end = 12;
  assert.throws(() => materialize(challenge, contract, packet), { code: 'actual_selected_source_unavailable' });
});

test('maintenance preserves issued proposal and raw stage separately from native transaction receipts', () => {
  const projected = maintenance({ phase: 'maintenance.decision', stage: 'issued', parentID: 'root',
    proposal: { proposal_id: 'opaque', action: 'delete' }, candidate: { decision: { action: 'delete' } },
    permission: { action: 'delete', granted: false } });
  assert.equal(projected.proposal_id, 'opaque');
  assert.equal(projected.permission.granted, false);
  assert.equal(projected.proposal.action, 'delete');
  assert.equal(receipt({ status: 'committed' }).operation_id, null);
});

test('usage projection retains numeric reported tokens while unknown actual cost stays null', () => {
  const result = usage({ tokens: { input: 10, output: 3, cache: { read: 2 }, secret: 'WITHHELD' },
    cost: 0, time: { created: 100, completed: 140 }, secret: 'WITHHELD' });
  assert.equal(result.tokens.input, 10);
  assert.equal(result.latency_ms, 40);
  assert.equal(result.cost, null);
  assert.equal(JSON.stringify(result).includes('WITHHELD'), false);
});
