const { wire } = require('./control.cjs');
const { createFixture } = require('./fixture.cjs');
const { caseLimits } = require('./inventory.cjs');
const { boundSDK } = require('./sdk-boundary.cjs');
const { createLedger } = require('./ledger.cjs');
const { egress } = require('./egress.cjs');
const { nativeRuntime } = require('./native-runtime.cjs');
const { requireStage, identifier, TransportBlocked } = require('./value.cjs');
const { preparePermissions } = require('./permission-configuration.cjs');
const { providerWire } = require('./provider-wire.cjs');
const { selectionShape } = require('./selected-binding.cjs');
const { profile, localDimensions } = require('./controlled-parent.cjs');
const { population } = require('./population.cjs');
const { hash } = require('./value.cjs');
const { executionProfile, captureCollectionWindow, assertExecutionProfile } = require('./execution-profile.cjs');

async function install(input, options, dependencies = {}) {
  requireStage(options?.kind === 'quality-full-population-plugin-v1' && options.source_sha256 === require('./authorization.cjs').sources().digest &&
    options.approval_id && options.socket && options.token && options.paths.database.startsWith(`${options.privateRoot}/`),
  'explicit_plugin_composition_required');
  const selected = population(options.evaluation);
  const execution = executionProfile(selected, options.captureExecutionMs, options.maintenanceExecutionMs);
  const collection = captureCollectionWindow(execution, Boolean(selected.resolveCase(options.case).original.used));
  selected.resolveCase(options.case);
  requireStage(!selected.descriptor || options.evaluation_sha256 === hash(selected.descriptor), 'evaluation_grant_binding');
  if (options.network_binding) selectionShape(options.network_binding, options.endpoints, options.approval_id);
  else requireStage(dependencies.fetch, 'selected_provider_binding');
  const rpc = dependencies.rpc ?? wire(options.socket, options.token, undefined, execution.capture_ms, execution.maintenance_ms);
  const limits = caseLimits(options.case, selected, execution.capture_ms, execution.maintenance_ms);
  requireStage(!options.execution_profile || options.execution_profile === profile, 'controlled_profile');
  if (options.execution_profile) for (const [key, original] of Object.entries(localDimensions))
    limits[key] = key.endsWith('_bytes') ? limits.parent_requests * 262144 : limits[original];
  const used = {}; let charges = {}; const events = []; let recording = false; let packet; let terminal;
  const charged = (key, amount = 1) => {
    requireStage(Number.isSafeInteger(amount) && amount >= 0 && Number.isSafeInteger(limits[key]) &&
      (used[key] ?? 0) + amount <= limits[key], `plugin_budget_${key}`);
    used[key] = (used[key] ?? 0) + amount;
    if (!recording && !(options.network_binding && ['provider_requests', 'provider_request_bytes', 'provider_response_bytes'].includes(key)))
      charges[key] = (charges[key] ?? 0) + amount;
  };
  const ledger = createLedger({ charge: charged });
  let completion = Promise.withResolvers();
  const reviews = new Map();
  const originalFetch = dependencies.fetch ?? globalThis.fetch;
  let hooks;
  let cleanupIds;
  let disposal;
  const deletionAttempts = new Set();
  const client = Object.create(input.client);
  const session = Object.create(input.client.session);
  session.delete = async (request) => {
    const id = request.path.id;
    requireStage(!deletionAttempts.has(id), 'child_delete_unknown');
    deletionAttempts.add(id);
    return input.client.session.delete(request);
  };
  Object.defineProperty(client, 'session', { value: session, configurable: true });
  const owns = (id) => Boolean(id && (hooks?.state().active?.root === id || hooks?.state().children.includes(id)));
  const transport = egress({ origin: input.serverUrl.origin, endpoints: options.endpoints, charge: charged,
    providerTransport: options.network_binding ? providerWire({ socket: options.socket, token: options.token,
      binding: options.network_binding, root: () => hooks?.state().active?.root }, dependencies.providerSend) : originalFetch,
    session: owns, cleanupSession: (id) => cleanupIds ? cleanupIds.has(id) : owns(id), transport: originalFetch });
  if (!dependencies.fetch) globalThis.fetch = transport.global;
  const actualNative = dependencies.native ?? await nativeRuntime(options, charged);
  let setup;
  const source = async (method, value) => (await rpc('/boundary', { method, value })).value;
  const target = { charge: charged, reviewAllowed: () => packet.review,
    async user(value) {
      await source('user', value); ledger.begin(value.message.sessionID, value.message.id);
    }, prepare: (value) => source('prepare', value), tool: (value) => source('tool', value),
    complete: (value) => source('complete', value),
    record(event) {
      recording = true;
      try { ledger.record(event); events.push(event); } finally { recording = false; }
    } };
  hooks = await (dependencies.fixture ?? createFixture)({ ...input, client }, { charge: charged,
    invoke: options.execution_profile ? async (...args) => { await flush(); return actualNative.invoke(...args); } : actualNative.invoke,
    execution_profile: options.execution_profile, captureExecutionMs: execution.capture_ms, maintenanceExecutionMs: execution.maintenance_ms, endpoints: options.endpoints, flush,
    database: () => options.paths.database, binding() {}, async writeCarrier(translation) {
      await rpc('/boundary', { method: 'prepare', value: { materialize: translation } });
    }, review(event) {
      if (event.execution_profile !== undefined) assertExecutionProfile(event.execution_profile, execution);
      reviews.set(`${event.parentID}/${event.user_id}/${event.workflow}`, event);
      if (event.workflow === 'capture') completion.resolve(); } });
  const inheritedHeaders = hooks['chat.headers'];
  const inheritedConfig = hooks.config;
  function dispose() { disposal ??= hooks.dispose(); return disposal; }
  const expose = { ...hooks, dispose,
    async config(config) {
      requireStage(config.provider?.['openai-b1'] && !config.provider['openai-b1'].options?.fetch, 'provider_configuration_mismatch');
      config.provider['openai-b1'].options = { ...config.provider['openai-b1'].options,
        fetch: (input, init) => options.execution_profile ? hooks.controlledProvider(input, init, transport.provider) :
          hooks.observedProvider(input, init, transport.provider), maxRetries: 0 };
      setup ??= preparePermissions(options.case, actualNative, options.paths.database, selected);
      config.permission = (await setup).permission;
      await inheritedConfig?.(config);
    },
    async 'chat.headers'(event, output) {
      await inheritedHeaders?.(event, output);
      output.headers[transport.correlation] = event.sessionID;
    } };
  async function flush() {
    do {
      const batch = []; let bytes = 0;
      while (events.length && bytes + Buffer.byteLength(JSON.stringify(events[0])) <= 196608) {
        const event = events.shift(); bytes += Buffer.byteLength(JSON.stringify(event)); batch.push(event);
      }
      requireStage(batch.length || !events.length, 'control_observation_budget');
      const billed = charges; charges = {};
      await rpc('/observations', { charges: billed, events: batch });
    } while (events.length);
  }
  async function command(message) {
    if (message.method === 'bind') {
      requireStage(message.value.captureExecutionMs === undefined || message.value.captureExecutionMs === execution.capture_ms, 'capture_execution_profile_mismatch');
      assertExecutionProfile(executionProfile(undefined, execution.capture_ms, message.value.maintenanceExecutionMs), execution);
      packet = message.value; terminal = null; reviews.clear(); completion = Promise.withResolvers(); hooks.bind(packet, target); return {};
    }
    if (message.method === 'initialize') {
      setup ??= preparePermissions(options.case, actualNative, options.paths.database, selected);
      return { origin: (await setup).origin };
    }
    if (message.method === 'seed') { requireStage(setup, 'permission_setup_required'); return (await setup).seed(message.value); }
    if (message.method === 'wait') {
      requireStage(message.value.captureExecutionMs === undefined || message.value.captureExecutionMs === execution.capture_ms, 'capture_execution_profile_mismatch');
      assertExecutionProfile(executionProfile(undefined, execution.capture_ms, message.value.maintenanceExecutionMs), execution);
      const timeout = message.value.timeout_ms ?? collection.inner_ms;
      requireStage(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= collection.inner_ms, 'review_collection_budget');
      requireStage(!message.value.recovery_only, 'prior_native_dispatch_unobserved');
      let timer;
      try { if (message.value.review) await Promise.race([completion.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TransportBlocked('review_deadline')), timeout); timer.unref?.();
      })]); } finally { clearTimeout(timer); }
      requireStage(setup || !message.value.seed_bindings?.length, 'permission_setup_required');
      const keys = setup ? (await setup).seedKeys(message.value.seed_bindings ?? []) : [];
      const final_seed_state = keys.length ? await actualNative.readSeedState(keys) : { keys: [], records: [], receipt: null };
      return { capture_execution_profile: execution, reviews: [...reviews.values()], terminal: 'actual_capture_review', final_seed_state, resources: { ...used } };
    }
    if (message.method === 'close') {
      const state = hooks.state();
      requireStage(!message.value.session || message.value.session === state.active?.root, 'cleanup_session_unowned');
      const owned = [...state.children, message.value.session].filter(Boolean);
      requireStage(owned.every(identifier), 'cleanup_session_unowned');
      cleanupIds = new Set(owned);
      await dispose();
      const ids = [...new Set([...hooks.state().children, message.value.session].filter(Boolean))];
      requireStage(ids.every((id) => cleanupIds.has(id)), 'cleanup_session_unowned');
      const cleanup = boundSDK(client, charged);
      for (const id of ids) {
        requireStage(!deletionAttempts.has(id), 'child_delete_unknown');
        const stopped = await cleanup.session.abort({ path: { id } });
        requireStage(!stopped.error && stopped.data === true, 'child_abort_unknown');
        const deleted = await cleanup.session.delete({ path: { id } });
        requireStage(!deleted.error && deleted.data === true, 'child_delete_unknown');
      }
      terminal = 'closed'; return { children: 0, recovery_required: actualNative.uncertain() || ledger.snapshot().recovery_required };
    }
    requireStage(false, 'unknown_plugin_command');
  }
  async function pump() {
    await rpc('/ready', { approval_id: options.approval_id, source_sha256: options.source_sha256, captureExecutionMs: execution.capture_ms, maintenanceExecutionMs: execution.maintenance_ms });
    while (!terminal) {
      const message = await rpc('/next'); if (message.method === 'stop') return;
      let value; let failure;
      try { value = await command(message); } catch (error) { failure = error.code ?? 'plugin_operation_failed'; }
      await flush(); await rpc('/result', { id: message.id, value, ...(failure ? { error: failure } : {}) });
    }
  }
  expose.qualityPump = pump;
  if (!dependencies.rpc) pump().catch(() => { terminal = 'control_lost'; dispose(); });
  return expose;
}
module.exports = { install };
