import { clean } from "../capture/observed/value.js";
import { captureExecutionProfile } from "../capture/execution-profile.js";
import { fingerprint, requireMaintenance } from "./boundary.js";
import { createMaintenanceBackend } from "./backend.js";
import { createMaintenanceRegistry } from "./contract.js";
import { createMaintenanceExecutor } from "./executor.js";
import { createMaintenanceInputGuard } from "./input.js";
import { createMaintenanceFrames } from "./continuity.js";
import { createMaintenancePermissionGate } from "./permission.js";
import { createMaintenanceReviewer } from "./reviewer.js";
import { createMaintenanceScheduler } from "./scheduler.js";
import { createMaintenanceTasks } from "./tasks.js";
import { createUsageRegistry } from "./usage.js";

export function createMaintenance(input, runtime, options = {}) {
  const usage = createUsageRegistry({ clock: options.clock });
  const gate = createMaintenancePermissionGate();
  let current;
  const registry = createMaintenanceRegistry({ usage, permissionGate: gate, current: () => current });
  const frames = createMaintenanceFrames({ clock: options.clock });
  const tasks = createMaintenanceTasks(registry.cancel, frames);
  const inputGuard = createMaintenanceInputGuard(tasks);
  const backend = createMaintenanceBackend(runtime, options.invoke);
  const summaries = new Map();
  const jobs = new Set();
  let configVersion = 0;
  async function origin(turn) {
    const state = await runtime.context(turn.task.parentID);
    const targets = await runtime.selected(state, { signal: turn.controller.signal });
    tasks.check(turn);
    return fingerprint([backend.freeze({ sessionID: turn.task.parentID }).database, state.directory, targets]);
  }
  const reviewer = createMaintenanceReviewer({ client: input.client, tasks, registry, usage, backend, origin,
    observation: input.maintenanceObservation, executionProfile: captureExecutionProfile(input.captureExecutionMs, input.maintenanceExecutionMs) });
  const scheduler = createMaintenanceScheduler({ client: input.client, runtime, tasks, frames, reviewer, summaries, jobs,
    observation: input.maintenanceObservation, captureExecutionMs: input.captureExecutionMs, maintenanceExecutionMs: input.maintenanceExecutionMs });
  const apply = createMaintenanceExecutor({ client: input.client, runtime, tasks, gate, registry, backend,
    origin, setCurrent(value) { current = value; }, configEpoch: () => configVersion });
  async function registerRead(receipt, args, context) {
    if (!tasks.parents.has(context.sessionID)) return receipt;
    const { turn, caller } = tasks.caller(context, "memocap_read", args);
    if (receipt.status !== "ok" || receipt.record_changed || receipt.backend !== "local") return receipt;
    const entry = receipt.results[0];
    requireMaintenance(entry.completeness === "full", "full_read_required");
    const snapshot = await backend.read([args], context);
    tasks.check(turn);
    const record = snapshot.records[0].snapshot;
    requireMaintenance(record && record.content === entry.memory.content && record.id === args.id && record.placement === args.placement, "snapshot_changed");
    if (!clean(record)) return receipt;
    const read = usage.registerFullRead({ operation: "read", status: "ok", completeness: "full", database: snapshot.database,
      snapshot: record, content_hash: entry.content_hash }, caller);
    return { ...receipt, maintenance_read: read };
  }
  async function execute(args, context) {
    try {
      if (args.operation === "apply") return apply(args, context);
      requireMaintenance(args.operation === "use", "unbound_proposal");
      const { turn, caller } = tasks.caller(context, "memocap_maintain", args);
      requireMaintenance(turn.phase === "observed" && turn.used.length < 3, "input_budget");
      const { operation, ...declaration } = args;
      await runtime.readPermission.authorize(context, { operation: "maintenance_use", id: args.id, placement: args.placement }, true);
      const checked = await backend.read([args], context);
      tasks.check(turn);
      const used = usage.declareUse(declaration, caller, checked.records[0].snapshot);
      requireMaintenance(used.database === checked.database, "database_changed");
      requireMaintenance(turn.used.every((entry) => entry.snapshot.id !== used.snapshot.id || entry.snapshot.placement !== used.snapshot.placement), "already_used");
      turn.used.push(used);
      turn.origin = await origin(turn);
      return { status: "used", use_id: used.use_id, id: used.snapshot.id, placement: used.snapshot.placement,
        content_hash: used.content_hash, spans: used.spans, attestation: "agent_declaration_bound_to_native_full_read" };
    } catch (error) { return { status: "blocked", error: { code: error.code ?? "maintenance_failed" } }; }
  }
  runtime.maintenanceStatus = (id) => summaries.get(id)?.value ?? { status: "not_run" };
  const owns = (id) => tasks.workers.has(id);
  return { registerRead, execute, config() { configVersion++; }, owns,
    before(input, output) {
      const worker = tasks.workers.get(input.sessionID);
      if (!worker) return tasks.before(input, output);
      tasks.check(worker.turn);
      requireMaintenance(!worker.closed && worker.stage === "commit" && input.tool === "memocap_maintain" && !worker.callID, "unbound_tool");
      worker.turn.tool_calls++;
      worker.callID = input.callID;
    },
    params(input, output) {
      const worker = tasks.workers.get(input.sessionID);
      if (!worker) return;
      requireMaintenance(!worker.closed && worker.turn.model_calls < 3, "model_budget");
      tasks.check(worker.turn);
      worker.turn.model_calls++;
      output.maxOutputTokens = Math.min(output.maxOutputTokens ?? 2048, 2048);
    },
    messages: inputGuard.messages, system: inputGuard.system,
    observe: tasks.observe, event: scheduler.event, coordinator: { owns, beforeReview: scheduler.beforeReview },
    async dispose() { tasks.dispose(); await Promise.allSettled([...jobs]); registry.dispose(); summaries.clear(); },
  };
}
