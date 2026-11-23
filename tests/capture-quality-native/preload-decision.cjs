const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { hash, implementationFingerprint, validateProfile } = require('./approval.cjs');
const { CanaryBlocked } = require('./entry.cjs');

const sourceCommit = '810c0eba1a7348036f8bdf61e6632d0c36c6876c';
const auditedHost = 'feaafead8cd563af0c2dcb386b0757e4355e327ebb6bd1aaad5440fe2f83596c';
const managedPaths = Object.freeze(['/Library/Application Support/opencode/opencode.json',
  '/Library/Application Support/opencode/opencode.jsonc',
  '/Library/Managed Preferences/liuyuyu/ai.opencode.managed.plist',
  '/Library/Managed Preferences/ai.opencode.managed.plist']);
const established = new WeakSet();

function establishPreload({ input, approval, paths, env, pure, preparation }, dependencies = {}) {
  const io = dependencies.io ?? fs;
  if (process.platform !== 'darwin' || os.userInfo().username !== 'liuyuyu') throw new CanaryBlocked('preload_exact_platform_required');
  if (typeof preparation?.recheck !== 'function') throw new CanaryBlocked('preload_preparation_required');
  const directories = [path.join(paths.config, 'opencode'), paths.config];
  const layout = { HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', TMPDIR: 'tmp' };
  if (Object.entries(layout).some(([key, name]) => paths[name] !== path.join(input.privateRoot, name) || env[key] !== paths[name])
    || env.OPENCODE_CONFIG !== input.profileRef || env.OPENCODE_CONFIG_DIR !== paths.config
    || ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_MODELS_FETCH',
      'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_LSP_DOWNLOAD'].some((key) => env[key] !== 'true')
    || ['OPENCODE_AUTH_CONTENT', 'OPENCODE_DB', 'OPENCODE_TEST_HOME', 'OPENCODE_TEST_MANAGED_CONFIG_DIR']
      .some((key) => Object.hasOwn(env, key))) throw new CanaryBlocked('preload_environment_mismatch');
  if (io.existsSync(path.join(paths.data, 'opencode', 'auth.json'))) throw new CanaryBlocked('preload_private_auth_present');
  const artifactHash = dependencies.artifactHash ?? ((file) => hash(io.readFileSync(file)));
  if (approval.host.version !== '1.19.5' || approval.host.sha256 !== auditedHost
    || artifactHash(approval.host.path) !== auditedHost) throw new CanaryBlocked('preload_exact_host_mismatch');
  if (implementationFingerprint(io) !== approval.implementation) throw new CanaryBlocked('preload_implementation_changed');
  const profile = io.readFileSync(input.profileRef);
  if (hash(profile) !== approval.profile_sha256) throw new CanaryBlocked('preload_profile_changed');
  validateProfile(JSON.parse(profile.toString('utf8')), input.providerDestinations);
  const identities = Object.freeze(pure ? [] : [pathToFileURL(path.join(__dirname, 'fixture.mjs')).href]);
  const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  if (JSON.stringify(content.plugin) !== JSON.stringify(identities) || JSON.stringify(content.mcp) !== '{}') {
    throw new CanaryBlocked('preload_task_config_mismatch');
  }
  const proof = preparation.recheck();
  if (proof?.kind !== 'owned-preload-v1' || proof.private_root !== input.privateRoot || proof.home !== paths.home
    || proof.config !== paths.config || proof.write_access !== 'W_OK_denied'
    || JSON.stringify(proof.directories) !== JSON.stringify(directories)) throw new CanaryBlocked('preload_preparation_required');
  if (managedPaths.some((file) => io.existsSync(file))) throw new CanaryBlocked('preload_managed_source_present');
  const result = Object.freeze({ status: 'source_supported', source_commit: sourceCommit, host_sha256: auditedHost,
    implementation: approval.implementation, profile_sha256: approval.profile_sha256,
    private_root: input.privateRoot, install_directories: Object.freeze(directories),
    managed_paths: managedPaths, managed_presence: 'all_absent', identities,
    dependency_install: 'W_OK_denied_before_Npm_install', source_build_binding: 'not_cryptographically_established' });
  established.add(result);
  return result;
}

function isAuditedPreload(result, expectedIdentities) {
  return established.has(result) && JSON.stringify(result.identities) === JSON.stringify(expectedIdentities);
}

module.exports = { establishPreload, isAuditedPreload, auditedHost, managedPaths };
