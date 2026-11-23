const { population: selectedPopulation } = require('./population.cjs');
const { createCarrier } = require('./carrier.cjs');
const { createCustody } = require('./custody.cjs');
const { createLedger } = require('./ledger.cjs');
const { createMeter, caseInventory } = require('./inventory.cjs');
const { executionProfile, captureCollectionWindow } = require('./execution-profile.cjs');
const { selectedV1Host } = require('./authorization.cjs');
const { requireStage, TransportBlocked, hash, size, identifier, bounded, startupDiagnostics } = require('./value.cjs');

async function runCase(id, options) {
  const population = selectedPopulation(options.population);
  const execution = executionProfile(population, options.captureExecutionMs, options.maintenanceExecutionMs);
  const { resolveCase, mapping } = population;
  const { original, entry, adoption_keys } = resolveCase(id);
  let meter;
  let session;
  let custody;
  let ledger;
  let carrier;
  let closed;
  let failure;
  let startup;
  let attemptedOpen = false;
  let setupRecovery = false;
  const setupAttempts = [];
  const controller = new AbortController();
  const seeds = [];
  const turns = [];
  const completionEvidence = [];
  const host = options.host;
  try {
    const authorizedMeter = createMeter(options.budget, host.mode, population, { ...options.accounting, captureExecutionMs: execution.capture_ms, maintenanceExecutionMs: execution.maintenance_ms });
    meter = options.meter ?? authorizedMeter;
    requireStage(meter.mode === authorizedMeter.mode && meter.inventory_sha256 === authorizedMeter.inventory_sha256 &&
      meter.approval_id === authorizedMeter.approval_id && meter.accounting_sha256 === authorizedMeter.accounting_sha256,
    'meter_approval_mismatch');
    const requests = original.turns ?? [{ user: mapping.maintenance_request.text }];
    const clean = (await import('../../plugin/capture/screen.js')).clean;
    const screened = (value, turn) => ({ turn: turn + 1, user_hash: hash(value.user), status: 'screened_whole_unit', semantic: 'unexercised' });
    if (requests.every((value) => !clean(value.user))) turns.push(...requests.map(screened));
    else {
    const timeout = host.mode === 'offline' ? options.timeout_ms ?? 30000 : 30000;
    const invoke = (action) => bounded(action, timeout, controller);
    const selectedHost = host.mode === 'native' ? selectedV1Host(options.budget) : undefined;
    attemptedOpen = true;
    meter.charge('host_opens');
    session = await invoke(() => host.open({ signal: controller.signal, captureExecutionMs: execution.capture_ms, maintenanceExecutionMs: execution.maintenance_ms, timeout_ms: caseInventory(id, population, execution.capture_ms, execution.maintenance_ms).deadline_ms,
      maintenance: Boolean(original.record), stratum: entry.stratum, approval: options.budget, charge: meter.charge }));
    requireStage(identifier(session?.sessionID) && typeof session.origin === 'string' &&
      (host.mode === 'offline' || (selectedHost ? session.version === selectedHost.version :
        ['1.19.3', '1.19.5'].includes(session.version))), 'native_session_identity');
    session = { version: '1.19.3', root: '/offline/private-fixture', node: '/offline/node', ...session };
    requireStage(host.mode === 'offline' || session.root !== '/offline/private-fixture', 'explicit_private_carrier_required');
    carrier = createCarrier(id, session, population);
    custody = await createCustody(session, carrier);
    ledger = createLedger(meter);
    for (const snapshot of original.record ? [original.record, ...(original.participants ?? [])] : []) {
      if (host.mode === 'offline') { meter.charge('setup_writes'); meter.charge('seed_calls'); }
      setupRecovery = true;
      const setup = { logical: snapshot.key, content_hash: hash(snapshot.body), status: 'unknown' };
      setupAttempts.push(setup);
      const seeded = await invoke(() => host.seed({ content: snapshot.body, placement: session.origin }));
      requireStage(Number.isSafeInteger(seeded?.id) && seeded.id > 0 && seeded.placement === session.origin &&
        seeded.content === snapshot.body && seeded.readback?.content === snapshot.body && seeded.readback.id === seeded.id &&
        seeded.readback.placement === seeded.placement, 'seed_custody_missing');
      requireStage(host.mode === 'offline' || seeded.snapshot?.id === seeded.id && seeded.snapshot.placement === seeded.placement &&
        seeded.snapshot.content === seeded.content && hash(seeded.snapshot) === hash(seeded.readback.snapshot), 'native_seed_snapshot_missing');
      seeds.push({ logical: snapshot.key, logical_placement: snapshot.placement, setup_only: true, ...seeded });
      setup.status = 'verified'; setupRecovery = false;
    }
    for (const [turn, originalTurn] of requests.entries()) {
      if (!clean(originalTurn.user)) { turns.push(screened(originalTurn, turn)); continue; }
      requireStage(!ledger.snapshot().recovery_required, 'unknown_write_blocks_followup');
      carrier.turn(turn);
      const packet = { user: originalTurn.user, ...(originalTurn.assistant ? { conversation_assistant: originalTurn.assistant } : {}),
        operations: carrier.operations(turn), ...(original.record ? { adapter_added: true,
          request_origin: mapping.maintenance_request.origin,
          memories: seeds.map((seed, index) => ({ id: seed.id, placement: seed.placement,
             role: index === 0 ? 'primary' : 'comparison', access: original.used ? 'read' : 'recall',
             ...(!original.used ? { recall_query: seed.content } : {}),
             ...(adoption_keys.includes(seed.logical) ? { declaration: 'Read fully and explicitly declare the statements used through memocap_maintain use.' } : {}) })) } : {}) };
      let began = false;
      const completion = Promise.withResolvers();
      const evidence = { turn: turn + 1 };
      let callbackFailure;
      completionEvidence.push(evidence);
      const observe = (origin, action) => {
        try { return action(); }
        catch (error) {
          if (!callbackFailure) { callbackFailure = error; evidence.failure_origin = origin; }
          completion.resolve(callbackFailure); throw error;
        }
      };
      const reviewAllowed = entry.stratum !== 'recovery-safety';
      const boundary = {
        reviewAllowed: () => reviewAllowed,
        user(value) {
          observe('boundary.user', () => custody.user(value, { user: originalTurn.user, turn }));
          ledger.begin(session.sessionID, custody.current()); began = true;
        },
        prepare(token) { const translated = observe('boundary.prepare', () => carrier.prepare(token)); meter.charge('operations');
          meter.charge('carrier_writes', translated.files.length); return translated; },
        tool(value) { return observe('boundary.tool', () => custody.tool(value)); },
        complete(info) { observe('boundary.complete', () => custody.complete(info)); completion.resolve(); },
        record(event) { requireStage(event.kind !== 'native.dispatch' || reviewAllowed &&
          (event.workflow !== 'maintenance' || original.used), 'unscheduled_native_write'); ledger.record(event); },
        charge: meter.charge,
      };
      meter.charge('turns'); meter.charge('total_bytes', size(packet));
      requireStage(size(packet) <= 32768, 'root_packet_budget');
      await invoke(async () => {
        evidence.failure_origin = 'sdk.deliver';
        const delivered = await host.deliver(packet, boundary, { signal: controller.signal, timeout_ms: 30000 });
        if (evidence.failure_origin === 'sdk.deliver') delete evidence.failure_origin;
        if (delivered?.completion_response) evidence.sdk = delivered.completion_response;
        if (callbackFailure) throw callbackFailure;
        if (!began) evidence.native_user_observed = false;
        if (evidence.sdk && evidence.sdk.error !== 'none') {
          evidence.failure_origin = 'sdk.response';
          throw new TransportBlocked('native_prompt_error');
        }
        requireStage(began, 'native_user_missing');
        if (!evidence.sdk) return;
        evidence.failure_origin = 'sdk.response';
        requireStage(evidence.sdk.finish === 'stop', 'native_prompt_nonstop');
        evidence.failure_origin = 'boundary.completion_join';
        const aborted = () => completion.resolve(new TransportBlocked('host_boundary_aborted'));
        controller.signal.addEventListener('abort', aborted, { once: true });
        try {
          if (controller.signal.aborted) aborted();
          const callbackError = await completion.promise;
          if (callbackError) throw callbackError;
        } finally { controller.signal.removeEventListener('abort', aborted); }
        if (callbackFailure) throw callbackFailure;
        delete evidence.failure_origin;
      });
      requireStage(custody.finished(), 'native_completion_missing');
      const collection = captureCollectionWindow(execution, Boolean(original.used));
      const terminalTimeout = host.mode === 'offline' && options.timeout_ms !== undefined ? timeout + 3000 : collection.inner_ms;
      const result = await bounded(() => host.settle({ session: session.sessionID, user: custody.current(),
        timeout_ms: terminalTimeout, captureExecutionMs: execution.capture_ms, maintenanceExecutionMs: execution.maintenance_ms, review: reviewAllowed,
          recovery_only: entry.stratum === 'recovery-safety',
         seed_bindings: seeds.map(({ logical, logical_placement, setup_only, ...native }) => native) }, boundary), terminalTimeout + 3000, controller);
      if (callbackFailure) throw callbackFailure;
      if (result.capture_execution_profile !== undefined) requireStage(hash(result.capture_execution_profile) === hash(execution), 'capture_execution_profile_mismatch');
      if (original.record) {
        const events = ledger.snapshot().events;
        const reads = events.filter((event) => event.kind === 'memory.read');
        requireStage(!original.used || seeds.every((seed) => reads.some((event) => event.record?.id === seed.id &&
          event.record.placement === seed.placement && event.record.content === seed.content &&
          event.completeness === 'full' && identifier(event.receipt_id))), 'native_memory_read_missing');
        const uses = events.filter((event) => event.kind === 'memory.use');
        if (!original.used) requireStage(events.some((event) => event.kind === 'memory.recall' &&
          event.ids.includes(seeds[0].id)), 'native_recall_missing');
        const selected = seeds.filter((seed) => adoption_keys.includes(seed.logical));
        requireStage(uses.length === selected.length && new Set(uses.map((use) => use.use_id)).size === uses.length &&
          new Set(uses.map((use) => use.receipt_id)).size === uses.length && selected.every((seed) => {
            const matches = uses.filter((use) => use.id === seed.id && use.placement === seed.placement);
            return matches.length === 1 && identifier(matches[0].use_id) && identifier(matches[0].receipt_id) &&
              matches[0].content_hash === hash(seed.content) && reads.some((read) => read.receipt_id === matches[0].receipt_id &&
                read.record.id === seed.id && read.record.placement === seed.placement && read.record.content === seed.content &&
                read.completeness === 'full' && events.indexOf(read) < events.indexOf(matches[0]));
          }),
        original.used ? 'native_adoption_missing' : 'recalled_unused_was_adopted');
      }
      turns.push({ turn: turn + 1, user_hash: hash(originalTurn.user), result });
    }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure = error instanceof TransportBlocked ? error.code : 'host_boundary_failed';
    if (error instanceof TransportBlocked && Object.hasOwn(error, 'startup_diagnostics')) {
      startup = startupDiagnostics(error.startup_diagnostics);
    }
  } finally {
    if (attemptedOpen) {
      try { meter.charge('host_closes'); closed = await bounded(() => host.close({ session: session?.sessionID,
        retain_recovery: setupRecovery || !session || (ledger?.snapshot().recovery_required ?? true) }), 3000, controller); }
      catch (error) { closed = { exited: false, removed: false, children: null, error_type: error instanceof Error ? error.name : 'unknown' }; }
      if (closed?.exited !== true || closed.children !== 0) failure ??= 'cold_cleanup_unconfirmed';
      if ((setupRecovery || ledger?.snapshot().recovery_required) && closed?.removed) failure ??= 'recovery_state_discarded';
    }
  }
  return { id, pointer: entry.pointer, stratum: entry.stratum, tuning_sha256: mapping.tuning_sha256,
     original_sha256: hash(original), status: failure ? 'blocked' : 'wired', reason: failure ?? null,
    ...(startup ? { startup_diagnostics: startup } : {}),
    capture_execution_profile: execution, surface: host.mode === 'offline' ? 'fake-host-wiring-only' : 'supplied-native-host',
    custody: custody?.rows() ?? [], seeds, setup_attempts: setupAttempts, setup_recovery_required: setupRecovery,
    turns, completion_evidence: completionEvidence, transport: carrier?.audit() ?? null,
    trace: ledger?.snapshot() ?? null, cleanup: closed ?? null, budget_used: meter?.snapshot() ?? null,
    runtime: host.mode === 'offline' ? 'NOT_RUN' : 'requires_independent_runtime_adjudication', quality_credit: false };
}
module.exports = { runCase };
