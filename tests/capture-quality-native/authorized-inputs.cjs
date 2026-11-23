const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parse } = require('jsonc-parser');
const { exactDestinations } = require('./entry.cjs');
const { validateProfile } = require('./approval.cjs');
const { projectModel, ModelProfileBlocked } = require('./model-profile.cjs');
const consumed = new WeakSet();
const inputFailures = new WeakMap();
const inputReasons = new Set([
  'credential_materialization_consent_required', 'credential_materialization_scope_mismatch',
  'canonical_input_paths_required', 'owned_inputs_cleanup_refused', 'owned_inputs_cleanup_failed',
  'selected_provider_not_supported', 'owned_input_layout_required', 'owned_input_directory_exists',
  'owned_input_parent_required', 'reviewed_destinations_required', 'source_config_invalid',
  'selected_provider_mismatch', 'source_transport_options_unsupported', 'source_model_metadata_unsupported',
  'credential_not_losslessly_representable', 'model_profile_rejected', 'owned_input_permissions_required',
  'input_preparation_failed',
]);

class InputBlocked extends Error {
  constructor(code) {
    super(code); this.name = 'InputBlocked'; this.code = code;
    if (inputReasons.has(code)) inputFailures.set(this, code);
  }
}
function inputBlockedReason(error) { return inputFailures.get(error); }
function requireInput(condition, code) { if (!condition) throw new InputBlocked(code); }
function inside(parent, child) { return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`); }
function textSafe(text) { return [...text].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127); }
function absolute(file) {
  return typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file && !/[{}]/u.test(file) && textSafe(file);
}
function canonical(file, io) {
  requireInput(absolute(file), 'canonical_input_paths_required');
  const parent = path.dirname(file);
  if (parent !== file) canonical(parent, io);
  try {
    const stat = io.lstatSync(file);
    requireInput(!stat.isSymbolicLink() && io.realpathSync(file) === file, 'canonical_input_paths_required');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function identity(file, stat) { return { path: file, dev: stat.dev, ino: stat.ino, uid: stat.uid }; }
function same(saved, stat) {
  return saved.dev === stat.dev && saved.ino === stat.ino && saved.uid === stat.uid && stat.uid === process.getuid();
}

function inspectSelectedModel(request, io = fs) {
  requireInput(request.providerID === 'openai-b1' && request.modelID === 'gpt-6.1-sol'
    && ['@ai-sdk/openai', '@ai-sdk/openai-compatible'].includes(request.sdk), 'selected_provider_not_supported');
  canonical(request.sourceConfig, io);
  const stat = io.lstatSync(request.sourceConfig);
  requireInput(stat.isFile() && stat.uid === process.getuid(), 'source_config_invalid');
  const fd = io.openSync(request.sourceConfig, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let source;
  try {
    requireInput(same(identity(request.sourceConfig, stat), io.fstatSync(fd)), 'source_config_invalid');
    const errors = [];
    source = parse(io.readFileSync(fd, 'utf8'), errors, { allowTrailingComma: true });
    requireInput(errors.length === 0 && source && typeof source === 'object' && !Array.isArray(source), 'source_config_invalid');
  } finally { io.closeSync(fd); }
  const provider = source.provider?.[request.providerID];
  const model = provider?.models?.[request.modelID];
  requireInput(provider?.npm === request.sdk && model && typeof model === 'object' && !Array.isArray(model)
    && provider.options?.baseURL === request.baseURL, 'selected_provider_mismatch');
  requireInput(Object.keys(provider.options).every(key => ['apiKey', 'baseURL', 'maxRetries'].includes(key)),
    'source_transport_options_unsupported');
  let metadata;
  try { metadata = projectModel(model); }
  catch (error) {
    if (error instanceof ModelProfileBlocked) throw new InputBlocked('source_model_metadata_unsupported');
    throw error;
  }
  return { sourceConfig: request.sourceConfig, providerID: request.providerID, modelID: request.modelID,
    sdk: request.sdk, baseURL: request.baseURL, maxRetries: 0, metadata };
}

function prepareAuthorizedInputs(request, gate, io = fs) {
  requireInput(gate?.authorized === true && gate.mode === 'credential-materialization-only'
    && ['fresh-explicit-credential-materialization', 'approved-work'].includes(gate.consent) && !consumed.has(gate),
  'credential_materialization_consent_required');
  const fields = ['sourceConfig', 'inputDirectory', 'canaryRoot', 'providerID', 'modelID', 'sdk', 'baseURL', 'providerDestinations'];
  requireInput(fields.every((field) => JSON.stringify(request[field]) === JSON.stringify(gate[field])),
    'credential_materialization_scope_mismatch');
  consumed.add(gate);
  const owned = [];
  let directory;
  let directoryCreated = false;
  const cleanup = () => {
    try {
      requireInput(directory && absolute(directory.path), 'owned_inputs_cleanup_refused');
      canonical(directory.path, io);
      const current = io.lstatSync(directory.path);
      requireInput(current.isDirectory() && same(directory, current), 'owned_inputs_cleanup_refused');
      const names = io.readdirSync(directory.path);
      requireInput(names.length === owned.length && names.every((name) => owned.some((item) => path.basename(item.path) === name)),
        'owned_inputs_cleanup_refused');
      for (const item of owned) {
        const stat = io.lstatSync(item.path);
        requireInput(path.dirname(item.path) === directory.path && stat.isFile() && !stat.isSymbolicLink()
          && stat.nlink === 1 && same(item, stat), 'owned_inputs_cleanup_refused');
      }
      for (const item of owned) io.unlinkSync(item.path);
      io.rmdirSync(directory.path);
    } catch (error) {
      throw new InputBlocked(error instanceof InputBlocked ? 'owned_inputs_cleanup_refused' : 'owned_inputs_cleanup_failed');
    }
  };
  try {
    requireInput(request.providerID === 'openai-b1' && request.modelID === 'gpt-6.1-sol'
      && ['@ai-sdk/openai', '@ai-sdk/openai-compatible'].includes(request.sdk), 'selected_provider_not_supported');
    for (const file of [request.sourceConfig, request.inputDirectory, request.canaryRoot]) canonical(file, io);
    requireInput(!inside(request.canaryRoot, request.inputDirectory) && !inside(request.inputDirectory, request.canaryRoot)
      && !inside(request.inputDirectory, request.sourceConfig), 'owned_input_layout_required');
    try { io.lstatSync(request.inputDirectory); throw new InputBlocked('owned_input_directory_exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = io.lstatSync(path.dirname(request.inputDirectory));
    requireInput(parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o022) === 0,
      'owned_input_parent_required');
    requireInput(exactDestinations(request.providerDestinations) && request.providerDestinations.length > 0,
      'reviewed_destinations_required');
    const destinations = request.providerDestinations;
    const sourceStat = io.lstatSync(request.sourceConfig);
    requireInput(sourceStat.isFile() && sourceStat.uid === process.getuid(), 'source_config_invalid');
    const sourceFD = io.openSync(request.sourceConfig, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let source;
    try {
      requireInput(same(identity(request.sourceConfig, sourceStat), io.fstatSync(sourceFD)), 'source_config_invalid');
      const errors = [];
      source = parse(io.readFileSync(sourceFD, 'utf8'), errors, { allowTrailingComma: true });
      requireInput(errors.length === 0 && source && typeof source === 'object' && !Array.isArray(source), 'source_config_invalid');
    } finally { io.closeSync(sourceFD); }
    const provider = source.provider?.[request.providerID];
    const model = provider?.models?.[request.modelID];
    requireInput(provider?.npm === request.sdk && model && typeof model === 'object' && !Array.isArray(model)
      && provider.options?.baseURL === request.baseURL, 'selected_provider_mismatch');
    requireInput(Object.keys(provider.options).every((key) => ['apiKey', 'baseURL', 'maxRetries'].includes(key)),
      'source_transport_options_unsupported');
    let metadata;
    try { metadata = projectModel(model); }
    catch (error) {
      if (error instanceof ModelProfileBlocked) throw new InputBlocked('source_model_metadata_unsupported');
      throw error;
    }
    const key = provider.options.apiKey;
    requireInput(typeof key === 'string' && key.length > 0 && key.trim() === key && textSafe(key),
      'credential_not_losslessly_representable');
    const native = /^\{file:(\/[^{}]+)\}$/u.exec(key);
    requireInput(native ? !inside(request.inputDirectory, path.resolve(native[1])) : !/[{}]/u.test(key),
      'credential_not_losslessly_representable');
    const credentialRef = native ? native[1] : path.join(request.inputDirectory, 'credential');
    const profileRef = path.join(request.inputDirectory, 'profile.json');
    const profile = { $schema: 'https://opencode.ai/config.json', model: `${request.providerID}/${request.modelID}`,
      enabled_providers: [request.providerID], provider: { [request.providerID]: { npm: request.sdk,
        models: { [request.modelID]: metadata }, options: { baseURL: request.baseURL,
          apiKey: `{file:${credentialRef}}`, maxRetries: 0 } } } };
    try { validateProfile(profile, destinations); } catch { throw new InputBlocked('model_profile_rejected'); }
    const bytes = `${JSON.stringify(profile, null, 2)}\n`;
    io.mkdirSync(request.inputDirectory, { mode: 0o700 });
    directoryCreated = true;
    const directoryStat = io.lstatSync(request.inputDirectory);
    directory = identity(request.inputDirectory, directoryStat);
    requireInput(directoryStat.isDirectory() && directoryStat.uid === process.getuid()
      && (directoryStat.mode & 0o777) === 0o700, 'owned_input_permissions_required');
    for (const [file, content] of [...(native ? [] : [[credentialRef, key]]), [profileRef, bytes]]) {
      const fd = io.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const stat = io.fstatSync(fd);
        owned.push(identity(file, stat));
        requireInput(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1
          && (stat.mode & 0o777) === 0o600, 'owned_input_permissions_required');
        io.writeFileSync(fd, content);
      }
      finally { io.closeSync(fd); }
    }
    return { profileRef, credentialRef, inputDirectory: directory.path,
      profileSha256: createHash('sha256').update(bytes).digest('hex'), sdk: request.sdk,
      model: profile.model, baseURL: request.baseURL, cleanup };
  } catch (error) {
    if (directoryCreated && !directory) throw new InputBlocked('owned_inputs_cleanup_refused');
    if (directory) cleanup();
    throw new InputBlocked(error instanceof InputBlocked ? error.code : 'input_preparation_failed');
  }
}
function main(args = []) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return { status: 'not_run',
    mode: 'credential-materialization-preparation-only', runtimeAuthorized: false,
    usage: 'Callable prepareAuthorizedInputs(request, freshExplicitGate); CLI supports --help only.' };
  return { status: 'blocked', reason: 'callable_explicit_gate_required' };
}
if (require.main === module) process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
module.exports = { inspectSelectedModel, prepareAuthorizedInputs, main, inputBlockedReason };
