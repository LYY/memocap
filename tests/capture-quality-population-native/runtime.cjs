const fs = require('node:fs');
const { authorize, authorizeSelectedV1, selectedV1Kind, sources } = require('./authorization.cjs');
const { concreteHost } = require('./concrete-host.cjs');
const { inventory, createMeter } = require('./inventory.cjs');
const { population } = require('./population.cjs');
const { fixturePrecondition } = require('./permission-configuration.cjs');
const { runCase } = require('./adapter.cjs');
const { hash, requireStage, TransportBlocked } = require('./value.cjs');
const controlledProfile = 'controlled_native_parent_genuine_curator_v1';
const { bindExecutionProfile } = require('./execution-profile.cjs');
async function runNative(input, suppliedGrant, priorSpend) {
  return runAdmitted(input, authorize(input, suppliedGrant), priorSpend);
}
async function runAdmitted(input, approval, priorSpend) {
  const settings = structuredClone(input);
  const selected = population(settings.evaluation);
  const execution = bindExecutionProfile(settings, approval, selected);
  settings.captureExecutionMs = execution.capture_ms;
  settings.maintenanceExecutionMs = execution.maintenance_ms;
  for (const { id } of selected.mapping.cases) fixturePrecondition(selected.resolveCase(id));
  const needed = inventory(selected, execution.capture_ms, execution.maintenance_ms);
  requireStage(!settings.execution_profile || settings.execution_profile === controlledProfile, 'controlled_profile');
  const retained = priorSpend === undefined ? settings.retained_ledger ?? {} : priorSpend;
  const accounting = { ...(selected.descriptor ? { retained_ledger: retained, execution_profile: settings.execution_profile ?? null } : {}),
    captureExecutionMs: execution.capture_ms, maintenanceExecutionMs: execution.maintenance_ms };
  const meter = createMeter(approval, 'native', selected, accounting);
  const localLimits = settings.execution_profile ? { scripted_root_generations: needed.limits.parent_requests,
    scripted_root_dispatches: needed.limits.parent_requests, scripted_root_request_bytes: needed.limits.parent_requests * 262144,
    scripted_root_response_bytes: needed.limits.parent_requests * 262144 } : {};
  const dimensions = ['requests', 'parent_requests', 'provider_requests', 'provider_request_bytes', 'provider_response_bytes'];
  requireStage(retained !== null && typeof retained === 'object' && !Array.isArray(retained), 'invalid_prior_spend');
  const prior = structuredClone(retained); const keys = Object.keys(prior);
  requireStage(keys.every((key) => Object.hasOwn(needed.limits, key) || Object.hasOwn(localLimits, key)) &&
    keys.every((key) => Number.isSafeInteger(prior[key]) && prior[key] >= 0) &&
    (keys.length === 0 || (dimensions.every((key) => Object.hasOwn(prior, key)) &&
    prior.requests === prior.provider_requests && prior.parent_requests + (prior.worker_requests ?? 0) === prior.requests &&
    (prior.requests > 0 || (prior.provider_request_bytes === 0 && prior.provider_response_bytes === 0)))), 'invalid_prior_spend');
  const local = {};
  requireStage(!(settings.execution_profile || selected.descriptor) || keys.length > 0 && Object.hasOwn(prior, 'worker_requests'), 'controlled_prior_spend');
  requireStage(!(settings.execution_profile || selected.descriptor) || approval.retained_ledger_sha256 === hash(prior), 'retained_ledger_grant_binding');
  for (const [key, value] of Object.entries(prior)) {
    if (selected.descriptor) continue;
    if (Object.hasOwn(localLimits, key)) {
      requireStage(value <= localLimits[key], `budget_${key}`); local[key] = value;
    } else meter.charge(key, value);
  }
  for (const [key, value] of Object.entries(prior)) {
    if (selected.descriptor) continue;
    const required = settings.execution_profile && key === 'parent_requests' ? 0 : needed.limits[key];
    if (required > 0) requireStage(value < approval.limits[key], `budget_${key}`);
    if (Object.hasOwn(localLimits, key)) requireStage(value < localLimits[key], `budget_${key}`);
  }
  const freshMeter = selected.descriptor ? meter : { ...meter, charge(key, amount = 1) {
    if (!Object.hasOwn(localLimits, key)) return meter.charge(key, amount);
    requireStage(Number.isSafeInteger(amount) && amount >= 0 && (local[key] ?? 0) + amount <= localLimits[key], `budget_${key}`);
    local[key] = (local[key] ?? 0) + amount;
  }, snapshot: () => ({ ...Object.fromEntries(Object.entries(meter.snapshot())
    .map(([key, value]) => [key, value - (prior[key] ?? 0)])),
    ...Object.fromEntries(Object.entries(local).map(([key, value]) => [key, value - (prior[key] ?? 0)])) }) };
  fs.writeFileSync(settings.paths.attempt, JSON.stringify({ kind: 'population-attempt', grant_sha256: hash(approval),
    source_sha256: sources().digest, inventory_sha256: hash(needed), state: 'consumed-before-start',
    capture_execution_profile: execution, ...(settings.execution_profile ? { execution_profile: settings.execution_profile } : {}) }), { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(settings.paths.privateRoot, { mode: 0o700 });
  const cases = [];
  const planned = selected.mapping.cases.map(({ id }) => id);
  const attempted = []; const failures = []; let stopReason = null; let stoppedID = null;
  for (const [index, { id }] of selected.mapping.cases.entries()) {
    attempted.push(id);
    try {
      const result = await runCase(id, { host: concreteHost(settings, approval, id, index), population: selected,
        budget: approval, meter: freshMeter, accounting, captureExecutionMs: execution.capture_ms, maintenanceExecutionMs: execution.maintenance_ms });
      cases.push(result);
      stopReason = result.setup_recovery_required ? 'unknown_setup_write' : result.trace?.recovery_required ? 'unknown_write' :
        result.cleanup?.exited !== true ? 'unknown_exit' :
          result.cleanup.children !== 0 || result.cleanup.removed !== true || result.cleanup.control_stopped !== true ||
          result.cleanup.listener_closed !== true || result.cleanup.error ? 'unknown_cleanup' :
            approval.kind === selectedV1Kind && ['native_session_identity', 'selected_host_artifact_changed',
              'selected_host_audit_changed'].includes(result.reason) ? result.reason : null;
    } catch (error) {
      stopReason = error instanceof TransportBlocked ? error.code : 'case_execution_failed';
      failures.push({ id, reason: stopReason, recovery_required: true, exit_status: 'unknown' });
    }
    if (stopReason) { stoppedID = id; break; }
  }
  if (!stopReason) {
    try { if (fs.readdirSync(settings.paths.privateRoot).length === 0) fs.rmdirSync(settings.paths.privateRoot); }
    catch (error) {
      stopReason = 'private_root_cleanup_failed';
      failures.push({ id: null, reason: stopReason, error_type: error instanceof Error ? error.name : 'unknown' });
    }
  }
  const completed = cases.map(({ id }) => id); const unexecuted = planned.slice(attempted.length);
  const cumulative = selected.descriptor ? meter.cumulativeSnapshot() : { ...meter.snapshot(), ...local };
  const fresh = freshMeter.snapshot();
  return { kind: 'full_population_native_runtime', population_status: stopReason ? 'incomplete' : 'complete', capture_execution_profile: execution,
    ...(selected.descriptor ? { evaluation: { id: selected.descriptor.id, input_sha256: selected.descriptor.input_sha256,
      mapping_sha256: selected.descriptor.mapping_sha256, evaluation_sha256: hash(selected.descriptor) } } : {}),
    planned_case_ids: planned, attempted_case_ids: attempted, completed_case_ids: completed, unexecuted_case_ids: unexecuted,
    stop_reason: stopReason, stopped_case_id: stoppedID, case_failures: failures,
    counts: { planned: planned.length, attempted: attempted.length, completed: completed.length, unexecuted: unexecuted.length },
    cases, budget_used: fresh, budget_prior_used: prior, budget_cumulative_used: cumulative, quality_credit: false,
    ...(settings.execution_profile ? { execution_profile: settings.execution_profile,
      parent_origin: 'controlled_task_driving_and_declared_adoption', curator_origin: 'genuine_production_generations',
      historical_worker_measurement: { direct: prior.worker_requests, derived: prior.requests - prior.parent_requests,
        invariant: 'requests = parent_requests + worker_requests = provider_requests' } } : {}) };
}
function controlled_native_parent_genuine_curator_v1(input, grant, retainedLedger) {
  return runNative({ ...input, execution_profile: controlledProfile }, grant, retainedLedger);
}
async function runSelectedV1R8(input, grant, retainedLedger) {
  const approval = authorizeSelectedV1(input, grant);
  requireStage(input.execution_profile === controlledProfile, 'controlled_profile');
  return runAdmitted(input, approval, retainedLedger);
}
async function main(args) {
  requireStage(args[0] === '--run' && args.length === 3, 'new_exact_population_grant_required');
  return runNative(JSON.parse(fs.readFileSync(args[1], 'utf8')), JSON.parse(fs.readFileSync(args[2], 'utf8')));
}
if (require.main === module) main(process.argv.slice(2)).then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`); if (result.population_status === 'incomplete') process.exitCode = 1;
})
  .catch((error) => { process.stderr.write(`${error.code ?? 'runtime_blocked'}\n`); process.exitCode = 1; });
module.exports = { runNative, main, controlled_native_parent_genuine_curator_v1, runSelectedV1R8 };
