const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { inventory } = require('./inventory.cjs');
const { hash, requireStage, TransportBlocked } = require('./value.cjs');
const { validateProfile } = require('../capture-quality-native/approval.cjs');
const { assertSelectedBinding } = require('./selected-binding.cjs');
const { population } = require('./population.cjs');
const { bindExecutionProfile } = require('./execution-profile.cjs');
const { isSupportedHost } = require('../../lib/opencode-host.js');
const root = path.resolve(__dirname, '../..');
const admitted = new WeakSet();
const selectedV1Kind = 'quality-full-population-native-selected-v1-r8';
const ordinaryIsolation = Object.freeze({ kind: 'ordinary-host-v1', permissions: 'ordinary-os-account', os_file_network_restrictions: false });
const fileHash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sources() {
  const entries = [];
  function visit(directory, extension) {
    for (const item of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file, extension);
      else if (file.endsWith(extension)) entries.push([file, fileHash(path.join(root, file))]);
    }
  }
  visit('plugin', '.js'); visit('tests/capture-quality-population-native', '.cjs');
  visit('tests/capture-quality-population-native', '.mjs'); visit('tests/capture-quality-population', '.cjs');
  visit('tests/capture-quality-native', '.cjs');
  for (const file of ['bin/cli.cjs', 'lib/opencode-host.js', 'package.json', 'node_modules/@opencode-ai/plugin/package.json',
    'node_modules/@opencode-ai/sdk/package.json', 'tests/capture-quality-population/mapping.json',
    'tests/capture-evaluation/tuning.json']) entries.push([file, fileHash(path.join(root, file))]);
  return { entries: entries.sort(([left], [right]) => left.localeCompare(right)), digest: hash(entries.sort()) };
}
function admit(input, grant, kind) {
  const selectedV1 = kind === selectedV1Kind;
  requireStage(grant?.kind === kind && grant.approved === true &&
    (selectedV1 ? grant.authorization === 'approved-work' : ['new-explicit-user-grant', 'approved-work'].includes(grant.authorization)) && grant.mode === 'native' &&
    /^[A-Za-z0-9_-]{16,96}$/.test(grant.approval_id ?? '') && grant.approval_id !== grant.consumed_canary_id,
  'new_exact_population_grant_required');
  const selected = population(Object.hasOwn(input, 'evaluation') ? input.evaluation : undefined);
  const execution = bindExecutionProfile(input, grant, selected);
  if (selected.descriptor || grant.evaluation_sha256 !== undefined) requireStage(
    selected.descriptor && grant.evaluation_sha256 === hash(selected.descriptor), 'evaluation_grant_binding');
  assertSelectedBinding(input, grant);
  requireStage(isDeepStrictEqual(input.isolation, ordinaryIsolation) && isDeepStrictEqual(grant.isolation, ordinaryIsolation),
    'ordinary_host_isolation_required');
  const needed = inventory(selected, execution.capture_ms, execution.maintenance_ms);
  requireStage(grant.inventory_sha256 === hash(needed) && grant.population_sha256 === needed.tuning_sha256 &&
    grant.source_sha256 === sources().digest && grant.profile_sha256 === hash(input.profile) &&
    hash(grant.paths) === hash(input.paths) && hash(grant.endpoints) === hash(input.endpoints) &&
    hash(grant.host) === hash(input.host) && hash(grant.native) === hash(input.native) && hash(grant.node) === hash(input.node) &&
    (selectedV1 ? isDeepStrictEqual(grant.host_source_audit, input.host_source_audit) :
      grant.host_source_audit === 'exact-1.19.5-810c0eba1a7348036f8bdf61e6632d0c36c6876c') &&
    grant.api_key_only === true && grant.no_refresh === true && grant.private_preload_reviewed === true, 'population_grant_binding');
  requireStage((selectedV1 ? isSupportedHost(input.host.version) : input.host.version === '1.19.5') && input.native.version === '0.7.0' &&
    Array.isArray(input.endpoints) && input.endpoints.length > 0 && input.endpoints.length <= 2 &&
    input.endpoints.every((value) => { const url = new URL(value); return url.protocol === 'https:' &&
      !url.username && !url.password && !url.hash && !url.search; }), 'exact_runtime_required');
  validateProfile(input.profile, input.endpoints);
  const origin = new URL(input.paths.server);
  requireStage(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.port &&
    !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash,
  'exact_loopback_endpoint_required');
  for (const value of [input.paths.privateRoot, input.paths.attempt]) requireStage(path.isAbsolute(value) && path.resolve(value) === value,
    'exact_private_path_required');
  requireStage(!fs.existsSync(input.paths.privateRoot) && !fs.existsSync(input.paths.attempt), 'population_attempt_consumed');
  requireStage(input.paths.case_roots?.length === selected.mapping.cases.length && input.paths.case_roots.every((value, index) =>
    value === path.join(input.paths.privateRoot, `run-${index + 1}`)), 'exact_case_private_paths_required');
  if (selectedV1) {
    const { host, host_source_audit: audit } = input;
    requireStage(Object.keys(host).length === 4 && [host.path, host.realpath].every((file) =>
      typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file) &&
      typeof host.sha256 === 'string' && /^[a-f0-9]{64}$/.test(host.sha256), 'selected_host_identity');
    requireStage(audit && Object.keys(audit).length === 2 && typeof audit.path === 'string' && audit.path.startsWith('.omo/') &&
      path.posix.normalize(audit.path) === audit.path && typeof audit.sha256 === 'string' && /^[a-f0-9]{64}$/.test(audit.sha256),
    'selected_host_audit_identity');
    const bytes = verifySelectedArtifacts(host, audit);
    let record;
    try { record = JSON.parse(bytes.toString('utf8')); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      requireStage(false, 'selected_host_audit_identity');
    }
    const probe = record?.version_probe;
    requireStage(record?.schema === 1 && record.kind === 'opencode-v1-source-audit' && record.batch === grant.approval_id &&
      record.verdict === 'approved' && isDeepStrictEqual(record.host, host) &&
      typeof record.source_revision === 'string' && /^[a-f0-9]{40}$/.test(record.source_revision) &&
      isDeepStrictEqual(probe?.argv, [host.path, '--version']) && probe.status === 0 && probe.stderr === '' &&
      [host.version, `${host.version}\n`, `${host.version}\r\n`].includes(probe.stdout), 'selected_host_audit_identity');
  }
  for (const artifact of selectedV1 ? [input.native, input.node] : [input.host, input.native, input.node]) {
    requireStage(path.isAbsolute(artifact.path) && fileHash(artifact.path) === artifact.sha256, 'runtime_artifact_hash');
  }
  const result = structuredClone(grant);
  if (selectedV1) { Object.freeze(result.host); Object.freeze(result.host_source_audit); }
  Object.freeze(result.network_binding.selection); Object.freeze(result.network_binding); Object.freeze(result);
  admitted.add(result); return result;
}
function verifySelectedArtifacts(host, audit) {
  let stage = 'selected_host_artifact_changed';
  try {
    requireStage(fs.realpathSync(host.path) === host.realpath && fileHash(host.realpath) === host.sha256, stage);
    stage = 'selected_host_audit_changed';
    const bytes = fs.readFileSync(path.join(root, audit.path));
    requireStage(createHash('sha256').update(bytes).digest('hex') === audit.sha256, stage);
    return bytes;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error instanceof TransportBlocked) throw error;
    throw new TransportBlocked(stage);
  }
}
function authorize(input, grant) { return admit(input, grant, 'quality-full-population-native-v1'); }
function authorizeSelectedV1(input, grant) { return admit(input, grant, selectedV1Kind); }
function assertAuthorization(value) {
  requireStage(admitted.has(value), 'new_exact_population_grant_required');
  return value.kind === selectedV1Kind ? value.host : undefined;
}
function selectedV1Host(approval) {
  if (approval?.kind !== selectedV1Kind) return undefined;
  return assertAuthorization(approval);
}
function recheckSelectedV1Host(approval) {
  const host = selectedV1Host(approval);
  if (host) verifySelectedArtifacts(host, approval.host_source_audit);
  return host;
}
module.exports = { authorize, authorizeSelectedV1, assertAuthorization, selectedV1Kind, selectedV1Host, recheckSelectedV1Host, sources, root, ordinaryIsolation };
