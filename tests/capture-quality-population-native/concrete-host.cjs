const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { assertAuthorization, recheckSelectedV1Host, sources } = require('./authorization.cjs');
const { control } = require('./control.cjs');
const { owned } = require('./owned.cjs');
const { launch } = require('./process.cjs');
const { sdkHost } = require('./sdk-host.cjs');
const { boundSDK } = require('./sdk-boundary.cjs');
const { requireStage, hash } = require('./value.cjs');
const { cleanupOwned } = require('./cleanup.cjs');
const { recheckStartup } = require('./startup.cjs');
const { basePermissions, fixturePermissions, validateInstancePath } = require('./permission-configuration.cjs');
const { caseLimits } = require('./inventory.cjs');
const { population } = require('./population.cjs');
const { bindExecutionProfile, assertExecutionProfile, executionProfile } = require('./execution-profile.cjs');

function concreteHost(input, approval, id, ordinal) {
  const selectedHost = assertAuthorization(approval);
  const selected = population(input.evaluation);
  const execution = bindExecutionProfile(input, approval, selected);
  selected.resolveCase(id);
  requireStage(!selected.descriptor || approval.evaluation_sha256 === hash(selected.descriptor), 'evaluation_grant_binding');
  requireStage(input.network_binding && hash(input.network_binding) === hash(approval.network_binding), 'selected_provider_binding');
  let privateState; let processState; let listener; let channel; let adapter; let location; let session;
  const seeds = [];
  return { mode: 'native', async open(request) {
    assertAuthorization(approval);
    requireStage(request.captureExecutionMs === undefined || request.captureExecutionMs === execution.capture_ms, 'capture_execution_profile_mismatch');
    requireStage(executionProfile(undefined, undefined, request.maintenanceExecutionMs).maintenance_ms === execution.maintenance_ms, 'capture_execution_profile_mismatch');
    requireStage(input.network_binding && hash(input.network_binding) === hash(approval.network_binding), 'selected_provider_binding');
    const privateRoot = input.paths.case_roots[ordinal];
    privateState = owned(privateRoot);
    const paths = privateState.paths;
    recheckStartup(privateState.preparation, paths);
    const token = randomUUID(); channel = control(token);
    channel.bind({ charge: request.charge }, privateState.materialize);
    channel.bindProvider({ binding: approval.network_binding, limits: caseLimits(id, selected, execution.capture_ms, execution.maintenance_ms), session: (root) => Boolean(session && root === session) });
    const environment = { HOME: paths.home, XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.data,
      XDG_CACHE_HOME: paths.cache, XDG_STATE_HOME: paths.state, TMPDIR: paths.tmp,
      PATH: `${path.dirname(input.node.path)}:/usr/bin:/bin`, MEMOCAP_DB: paths.database, MEMOCAP_BINARY: input.native.path,
      OPENCODE_CONFIG_DIR: paths.config, OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true' };
    const pluginOptions = { kind: 'quality-full-population-plugin-v1', approval_id: approval.approval_id,
      source_sha256: sources().digest, captureExecutionMs: execution.capture_ms, maintenanceExecutionMs: execution.maintenance_ms, case: id, paths, privateRoot, socket: paths.socket, token,
      endpoints: input.endpoints, network_binding: approval.network_binding, native: input.native, node: input.node, environment,
      ...(selected.descriptor ? { evaluation: selected.descriptor, evaluation_sha256: hash(selected.descriptor) } : {}),
      ...(input.execution_profile ? { execution_profile: input.execution_profile } : {}) };
    const config = { ...input.profile, share: 'disabled', autoupdate: false, snapshot: false,
      permission: basePermissions(id, selected),
      plugin: [[pathToFileURL(path.join(__dirname, 'plugin-entry.mjs')).href, pluginOptions]] };
    fs.writeFileSync(paths.settings, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    environment.OPENCODE_CONFIG = paths.settings;
    request.charge('control_listeners');
    listener = http.createServer(channel.handler);
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(paths.socket, resolve); });
    fs.chmodSync(paths.socket, 0o600);
    request.charge('host_processes');
    recheckStartup(privateState.preparation, paths);
    if (selectedHost) recheckSelectedV1Host(approval);
    processState = launch({ ...input, ...(selectedHost ? { host: { ...selectedHost, path: selectedHost.realpath } } : {}),
      server: input.paths.server, project: paths.project, environment });
    await processState.ready;
    const { createOpencodeClient } = await import('@opencode-ai/sdk');
    const sdk = createOpencodeClient({ baseUrl: input.paths.server, directory: paths.project,
      fetch: (target, init) => { requireStage(new URL(target instanceof Request ? target.url : target).origin ===
        new URL(input.paths.server).origin, 'controller_sdk_destination'); return fetch(target, { ...init, redirect: 'manual' }); } });
    const metered = boundSDK(sdk, request.charge);
    let version = input.host.version;
    if (selectedHost) {
      // Reuse the startup SDK reservation for an observed version before native setup or session creation.
      const health = await metered._client.get({ url: '/global/health', signal: request.signal });
      requireStage(!health.error && health.data?.version === selectedHost.version, 'native_session_identity');
      version = health.data.version;
    } else await metered.config.get({ signal: request.signal });
    const instance = await boundSDK({ _client: sdk.path }, request.charge)._client.get({
      query: { directory: paths.project }, signal: request.signal });
    requireStage(!instance.error && instance.data?.directory === paths.project, 'native_instance_path_invalid');
    validateInstancePath({ root: paths.project, worktree: instance.data.worktree });
    const joined = await channel.ready;
    requireStage(joined.approval_id === approval.approval_id && joined.source_sha256 === pluginOptions.source_sha256 &&
      joined.captureExecutionMs === execution.capture_ms && joined.maintenanceExecutionMs === execution.maintenance_ms, 'plugin_identity_mismatch');
    const initialized = await channel.call('initialize', {});
    location = { root: paths.project, worktree: instance.data.worktree, node: input.node.path,
      database: paths.database, origin: initialized.origin, version };
    const link = { concrete: true, async connected() { await channel.ready; },
      async bind(packet, boundary) {
        channel.bind(boundary, privateState.materialize);
        const rules = (await fixturePermissions(id, { ...location, evaluation: selected }, seeds)).root(packet);
        const updated = await metered.session.update({ path: { id: session }, body: { permission: rules } });
        requireStage(updated.data?.id === session && !updated.error, 'native_root_permission_update_unknown');
        return channel.call('bind', { ...packet, captureExecutionMs: execution.capture_ms, maintenanceExecutionMs: execution.maintenance_ms, root: session, review: request.stratum !== 'recovery-safety' });
      }, async wait(value) {
        requireStage(value.captureExecutionMs === execution.capture_ms, 'capture_execution_profile_mismatch');
        requireStage(value.maintenanceExecutionMs === execution.maintenance_ms, 'capture_execution_profile_mismatch');
        const result = await channel.call('wait', value);
        assertExecutionProfile(result.capture_execution_profile, execution); return result;
      } };
    adapter = sdkHost({ sdk, link, location, approval, model: { model: { providerID: 'openai-b1', modelID: 'gpt-6.1-sol' } },
      seed: async (value) => { const seeded = await channel.call('seed', value); seeds.push(seeded); return seeded; },
      close: (value) => channel.call('close', value) });
    const result = await adapter.open(request); session = result.sessionID; return result;
  }, seed: (value) => adapter.seed(value), deliver: (...args) => adapter.deliver(...args), settle: (...args) => adapter.settle(...args),
  close: (request) => cleanupOwned({ adapter, process: processState, listener, channel, private: privateState }, request) };
}
module.exports = { concreteHost };
