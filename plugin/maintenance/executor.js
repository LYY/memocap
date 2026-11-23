import { isDeepStrictEqual } from "node:util";
import { fingerprint, requireMaintenance } from "./boundary.js";
import { hostPermission, nativeData } from "./host-permission.js";
import { maintenancePermissionSnapshot } from "./permission.js";
import { nativeRequest } from "./request.js";

export function createMaintenanceExecutor({ client, runtime, tasks, gate, registry, backend, origin, setCurrent, configEpoch }) {
  async function execute(args, context) {
    const worker = tasks.workers.get(context.sessionID);
    requireMaintenance(worker && !worker.closed && !worker.consumed && worker.stage === "commit", "unbound_proposal");
    worker.consumed = true;
    const turn = worker.turn;
    const aborted = () => tasks.invalidate(turn, "worker_signal");
    context.abort.addEventListener("abort", aborted, { once: true });
    try {
      tasks.check(turn);
      requireMaintenance(!context.abort.aborted && turn.tool_calls === 1 && worker.callID && args.operation === "apply" &&
        Object.keys(args).length === 2 && args.proposal_id === turn.proposal.proposal_id, "call_mismatch");
      const messages = nativeData(await client.session.messages({ path: { id: context.sessionID }, signal: turn.controller.signal }));
      requireMaintenance(messages.some((message) => message.info.id === context.messageID && message.parts.some((part) =>
        part.type === "tool" && part.tool === "memocap_maintain" && part.callID === worker.callID &&
        ["pending", "running"].includes(part.state.status) && isDeepStrictEqual(part.state.input, args))), "call_mismatch");
      const proposal = registry.inspect(args.proposal_id);
      const before = await hostPermission(client, turn, proposal.target, context.sessionID);
      tasks.check(turn);
      const request = gate.issue(proposal, before.permission);
      try { await context.ask(request); }
      catch (error) { gate.respond(request, "denied", before.permission); throw error; }
      const after = await hostPermission(client, turn, proposal.target, context.sessionID);
      tasks.check(turn);
      const authorization = gate.respond(request, "resolved", after.permission);
      await runtime.readPermission.check({ sessionID: turn.task.parentID, agent: turn.agent }, true);
      const fresh = await backend.read(proposal.used.map((entry) => entry.snapshot), { ...context, abort: turn.controller.signal });
      requireMaintenance(await origin(turn) === turn.origin, "origin_changed");
      const final = await hostPermission(client, turn, proposal.target, context.sessionID);
      tasks.check(turn);
      requireMaintenance(fresh.database === proposal.database && fresh.records.every((entry) => entry.snapshot), "snapshot_changed");
      const epoch = configEpoch();
      const state = await runtime.context(turn.task.parentID);
      const generation = state.generation;
      const body = nativeRequest(proposal);
      const result = await backend.commit(proposal, { context, request: body, beforeSpawn(frozen) {
        tasks.check(turn);
        requireMaintenance(configEpoch() === epoch && generation === state.generation, "permission_changed");
        requireMaintenance(tasks.sourceHash(turn) === turn.sourceHash, "source_changed");
        requireMaintenance(!context.abort.aborted && turn.write_attempts === 0, "attempt_consumed");
        const permission = maintenancePermissionSnapshot(final.layers, proposal.target);
        setCurrent({ task: turn.task, database: frozen.database, records: fresh.records.map((entry) => entry.snapshot), permission, authorization });
        const consumed = registry.consume(proposal.proposal_id);
        requireMaintenance(fingerprint(consumed.request) === fingerprint(body), "proposal_changed");
        turn.write_attempts++;
        turn.phase = "dispatched";
      } });
      turn.outcome = { status: result.status, reason: result.outcome, operation_id: result.operation_id,
        ...(result.warning ? { warning: result.warning } : {}),
        memory_ids: proposal.target.participants.map((entry) => entry.id) };
      turn.native = result;
      runtime.invalidateCache(state);
      return result;
    } finally { context.abort.removeEventListener("abort", aborted); }
  }
  return (args, context) => {
    const turn = tasks.workers.get(context.sessionID)?.turn;
    const pending = execute(args, context).catch((error) => {
      const outcome = { status: turn?.write_attempts ? "unknown" : /permission|grant|denied/.test(error.code ?? "") ? "denied" : "blocked",
        reason: turn?.reason ?? error.code ?? "maintenance_failed" };
      if (turn) turn.outcome ??= outcome;
      return { status: outcome.status, error: { code: outcome.reason }, no_replay: true };
    });
    if (turn) turn.commitPending ??= pending;
    return pending;
  };
}
