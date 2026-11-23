const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { CanaryBlocked, prerequisites } = require('./entry.cjs');
const { projectModel, ModelProfileBlocked } = require('./model-profile.cjs');

const root = path.resolve(__dirname, '../..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = ['approval.cjs', 'controller.cjs', 'host.cjs', 'fixture.mjs', 'fixture-core.cjs',
  'journal.cjs', 'provider.cjs', 'native-proxy.cjs', 'projection.cjs', 'support.cjs', 'entry.cjs', 'driver.cjs', 'input.cjs',
  'diagnostics.cjs', 'preload-preparation.cjs', 'preload-decision.cjs', 'model-profile.cjs'];

function implementationFingerprint(io = fs) {
  const entries = files.map((name) => [path.join(__dirname, name), `tests/capture-quality-native/${name}`]);
  for (const name of ['bin/cli.cjs', 'package.json', 'node_modules/@opencode-ai/plugin/package.json',
    'node_modules/@opencode-ai/sdk/package.json']) entries.push([path.join(root, name), name]);
  const visit = (directory) => {
    for (const item of io.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else if (file.endsWith('.js')) entries.push([file, path.relative(root, file)]);
    }
  };
  visit(path.join(root, 'plugin'));
  return hash(entries.sort((left, right) => left[1].localeCompare(right[1]))
    .map(([file, label]) => `${label}\0${hash(io.readFileSync(file))}`).join('\n'));
}

function validateProfile(profile, destinations) {
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const allowed = ['$schema', 'model', 'small_model', 'provider', 'enabled_providers', 'disabled_providers'];
  if (!object(profile) || Object.keys(profile).some((key) => !allowed.includes(key)) ||
      Object.hasOwn(profile, '$schema') && profile.$schema !== 'https://opencode.ai/config.json' ||
      profile.model !== 'openai-b1/gpt-6.1-sol' || !object(profile.provider) ||
      Object.keys(profile.provider).length !== 1 || !profile.provider['openai-b1']) {
    throw new CanaryBlocked('profile_is_not_model_only');
  }
  const provider = profile.provider['openai-b1'];
  if (!object(provider) || Object.keys(provider).some((key) => !['name', 'npm', 'options', 'models'].includes(key)) ||
      provider.name !== undefined && typeof provider.name !== 'string' ||
      !['@ai-sdk/openai', '@ai-sdk/openai-compatible'].includes(provider.npm)) {
    throw new CanaryBlocked('profile_provider_not_supported');
  }
  if (!object(provider.models) || JSON.stringify(Object.keys(provider.models)) !== '["gpt-6.1-sol"]') {
    throw new CanaryBlocked('profile_model_registration_required');
  }
  let model;
  try { model = projectModel(provider.models['gpt-6.1-sol']); }
  catch (error) {
    if (error instanceof ModelProfileBlocked) throw new CanaryBlocked('profile_model_transport_override');
    throw error;
  }
  if (Object.keys(provider.models['gpt-6.1-sol']).some((key) => !Object.hasOwn(model, key)) ||
      !isDeepStrictEqual(provider.models['gpt-6.1-sol'], model)) {
    throw new CanaryBlocked('profile_model_transport_override');
  }
  const options = provider.options ?? {};
  if (!object(options) || Object.keys(options).some((key) => !['baseURL', 'apiKey', 'headers', 'timeout', 'maxRetries'].includes(key)) ||
      options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0) ||
      options.maxRetries !== undefined && options.maxRetries !== 0) {
    throw new CanaryBlocked('profile_provider_options');
  }
  const nativeReference = (value) => typeof value === 'string' && /^\{file:\/[^{}]+\}$/.test(value);
  if (!nativeReference(options.apiKey) || options.headers !== undefined && !object(options.headers) ||
      Object.values(options.headers ?? {}).some((value) => !nativeReference(value))) {
    throw new CanaryBlocked('native_file_credential_reference_required');
  }
  if (typeof options.baseURL !== 'string' || !destinations.every((url) => url.startsWith(`${options.baseURL.replace(/\/$/, '')}/`))) {
    throw new CanaryBlocked('profile_destination_mismatch');
  }
  const base = new URL(options.baseURL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new CanaryBlocked('profile_destination_mismatch');
  }
  const metadata = { ...profile, provider: { ...provider, models: { 'gpt-6.1-sol': model },
    options: { ...options, apiKey: undefined, headers: undefined } } };
  if (/\{(?:file|env):/.test(JSON.stringify(metadata)) ||
    JSON.stringify(profile.enabled_providers) !== '["openai-b1"]' ||
    profile.disabled_providers !== undefined && JSON.stringify(profile.disabled_providers) !== '[]') {
    throw new CanaryBlocked('profile_is_not_model_only');
  }
  if (profile.small_model !== undefined && profile.small_model !== profile.model) throw new CanaryBlocked('profile_secondary_model');
  return profile.model;
}

function approve(input, io = fs) {
  prerequisites(input);
  const approval = JSON.parse(io.readFileSync(input.approvalRef, 'utf8'));
  if (approval.kind !== 'quality-native-runtime-v2' || approval.authorized !== true ||
      !/^[a-zA-Z0-9_-]{8,96}$/.test(approval.batch ?? '') || approval.implementation !== implementationFingerprint(io) ||
      approval.private_root !== input.privateRoot || approval.attempt_file !== input.attemptFile ||
      approval.credential_reference !== input.credentialRef || approval.existing_capability !== true ||
      approval.preload_source_audit !== 'approved_for_exact_host_hash' || approval.egress_policy_reviewed !== true ||
      approval.preflight_loopback_only !== true ||
      JSON.stringify(approval.provider_destinations) !== JSON.stringify(input.providerDestinations) ||
      JSON.stringify(approval.auth_destinations) !== JSON.stringify(input.authDestinations)) {
    throw new CanaryBlocked('runtime_approval_mismatch');
  }
  if (io.existsSync(input.attemptFile)) throw new CanaryBlocked('attempt_consumed');
  if (io.existsSync(input.privateRoot)) throw new CanaryBlocked('private_root_exists');
  for (const file of [root, input.attemptFile, input.profileRef, input.approvalRef,
    approval.host?.path, approval.native?.path, approval.policy?.path, approval.preflight_policy?.path, approval.sandbox?.path]) {
    const relative = file && path.relative(input.privateRoot, file);
    if (!file || relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      throw new CanaryBlocked('private_root_overlaps_runtime_input');
    }
  }
  if (approval.host?.version !== '1.19.5') throw new CanaryBlocked('exact_host_required');
  if (approval.native?.version !== '0.7.0') throw new CanaryBlocked('exact_native_required');
  for (const library of ['plugin', 'sdk']) {
    const manifest = JSON.parse(io.readFileSync(path.join(root, `node_modules/@opencode-ai/${library}/package.json`), 'utf8'));
    if (manifest.version !== '1.19.3') throw new CanaryBlocked('exact_sdk_required');
  }
  for (const binary of [approval.host, approval.native, approval.sandbox, approval.policy, approval.preflight_policy]) {
    if (!binary || !path.isAbsolute(binary.path) || !/^[a-f0-9]{64}$/.test(binary.sha256 ?? '') ||
        hash(io.readFileSync(binary.path)) !== binary.sha256) throw new CanaryBlocked('runtime_artifact_mismatch');
  }
  const profile = io.readFileSync(input.profileRef);
  if (hash(profile) !== approval.profile_sha256) throw new CanaryBlocked('profile_hash_mismatch');
  validateProfile(JSON.parse(profile.toString('utf8')), input.providerDestinations);
  return { ...approval, model: { providerID: 'openai-b1', modelID: 'gpt-6.1-sol' },
    fingerprint: hash(JSON.stringify(approval)) };
}

module.exports = { approve, hash, implementationFingerprint, validateProfile, root };
