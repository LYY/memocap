const fs = require('node:fs');
const path = require('node:path');
const { hash, implementationFingerprint } = require('./approval.cjs');

function fakePreparation(privateRoot, paths) {
  return { directories: [path.join(paths.config, 'opencode'), paths.config], restore() {},
    recheck: () => ({ kind: 'owned-preload-v1', private_root: privateRoot, home: paths.home, config: paths.config,
      directories: [path.join(paths.config, 'opencode'), paths.config], write_access: 'W_OK_denied' }) };
}

function fakePreload(options, mutate = () => {}) {
  const { establishPreload, auditedHost } = require('./preload-decision.cjs');
  const profile = JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'openai-b1/gpt-6.1-sol',
    enabled_providers: ['openai-b1'], provider: { 'openai-b1': { npm: '@ai-sdk/openai-compatible', models: { 'gpt-6.1-sol': {} },
      options: { baseURL: 'https://provider.invalid', apiKey: '{file:/synthetic-never-opened}' } } } });
  const settings = { ...options, input: { ...options.input, privateRoot: path.dirname(options.paths.home),
    providerDestinations: ['https://provider.invalid/responses'] }, approval: { ...options.approval,
    implementation: implementationFingerprint(), profile_sha256: hash(profile),
    host: { ...options.approval.host, version: '1.19.5', sha256: auditedHost } },
    preparation: options.preparation ?? fakePreparation(path.dirname(options.paths.home), options.paths) };
  const reads = [];
  const io = { ...fs, existsSync: () => false, readFileSync: (file, ...args) => {
    reads.push(file);
    return file === settings.input.profileRef ? Buffer.from(profile) : fs.readFileSync(file, ...args);
  } };
  const dependencies = { io, artifactHash: () => auditedHost };
  mutate(settings, dependencies);
  const proof = establishPreload(settings, dependencies);
  return { proof, reads };
}

module.exports = { fakePreparation, fakePreload };
