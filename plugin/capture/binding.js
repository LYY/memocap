import { CaptureStop, data } from "./contract.js";
import { createCaptureInputGuard } from "./input.js";
import { observationHash } from "./observed/value.js";
import { permissionSnapshot } from "./permission.js";

export function createBinding({ client, runtime, operations, lifecycle, observed }) {
  function params(input, output) {
    const worker = lifecycle.workers.get(input.sessionID);
    if (!worker) return;
    if (worker.closed) throw new CaptureStop("worker_closed");
    const turn = worker.turn;
    lifecycle.check(turn);
    if (turn.model_calls >= 3 || (worker.admissions ?? 0) >= (worker.stage === 'extract' ? 2 : 1)) throw new CaptureStop("model_budget");
    worker.admissions = (worker.admissions ?? 0) + 1;
    turn.model_calls++;
    output.maxOutputTokens = Math.min(output.maxOutputTokens ?? 1024, 1024);
  }
  function before(input) {
    const worker = lifecycle.workers.get(input.sessionID);
    if (!worker) return;
    if (worker.closed) throw new CaptureStop("worker_closed");
    const turn = worker.turn;
    turn.tool_calls++;
    if (worker.stage !== "commit" || input.tool !== "memocap_remember") {
      lifecycle.invalidate(turn, "unbound_tool");
      throw new CaptureStop("unbound_tool");
    }
    if (!worker.callID) worker.callID = input.callID;
  }
  async function executeBound(args, context) {
    const worker = lifecycle.workers.get(context.sessionID);
    if (!worker) return;
    if (worker.closed) return { status: "blocked", error: { code: "worker_closed" } };
    const turn = worker.turn;
    if (worker.consumed) return { status: "blocked", error: { code: "attempt_consumed" } };
    worker.consumed = true;
    let checkedPhase;
    const aborted = () => lifecycle.invalidate(turn, "worker_signal");
    context.abort.addEventListener("abort", aborted, { once: true });
    try {
      lifecycle.check(turn);
      if (context.abort.aborted) throw new CaptureStop("worker_signal");
      if (worker.stage !== "commit" || turn.tool_calls !== 1 || !worker.callID ||
          args.content !== turn.candidate.body || Object.keys(args).some((key) => !["content", "type", "tags"].includes(key)) ||
          (args.type !== undefined && args.type !== (turn.candidate.kind ?? "context")) ||
          (args.tags !== undefined && (!Array.isArray(args.tags) || args.tags.length))) throw new CaptureStop("candidate_mismatch");
      const messages = data(await client.session.messages({ path: { id: context.sessionID }, signal: turn.controller.signal }));
      if (!messages.some((message) => message.info.id === context.messageID && message.parts.some((part) =>
        part.type === "tool" && part.tool === "memocap_remember" && part.callID === worker.callID &&
        ["pending", "running"].includes(part.state.status) && part.state.input?.content === turn.candidate.body))) {
        throw new CaptureStop("call_mismatch");
      }
      const childState = await runtime.context(context.sessionID);
      childState.targets = turn.targets;
      const checkSource = () => {
        const current = observed.snapshot(turn.parentID, turn.userID);
        if (current.findLast((message) => message.info.role === "user")?.info.id !== turn.userID) throw new CaptureStop("new_input");
        if (observationHash(current) !== turn.observationHash) throw new CaptureStop("source_changed");
        if (turn.frameHash && observationHash(observed.frame(turn.parentID, turn.userID, turn.origin)) !== turn.frameHash) throw new CaptureStop('source_changed');
      };
      const guard = async (phase) => {
        lifecycle.check(turn);
        await permissionSnapshot(client, turn);
        checkSource();
        lifecycle.check(turn);
        checkedPhase = phase;
      };
      const frozen = await operations.freezeCapture(context, { target: turn.target, content: turn.candidate.body,
        type: turn.candidate.kind ?? "context", tags: turn.candidate.tags, guard,
        beforeSpawn() {
          lifecycle.check(turn);
          if (turn.parentState.generation !== turn.runtimeGeneration) throw new CaptureStop("new_input");
          checkSource();
          lifecycle.writing(turn);
        } });
      const native = await frozen.execute();
      const saved = native.readback?.status === "ok" && native.readback.results?.some((entry) =>
        entry.memory.id === native.returned_ids[0] && entry.memory.placement === turn.target.placement &&
        entry.memory.content === turn.candidate.body && entry.memory.tags === turn.candidate.tags.join(','));
      const receipt = !saved && native.readback?.status === "ok" ? { ...native,
        readback: { ...native.readback, status: "failed", error: { code: "readback_mismatch" } } } : native;
      turn.receipt = receipt;
      turn.outcome = { status: saved ? "saved" : "unknown", reason: saved ? "saved_verified" : "readback_failed",
        memory_ids: receipt.returned_ids ?? [], receipt };
      return receipt;
    } catch (error) {
      const status = turn.write_attempts ? "unknown" : turn.reason ? "skipped" : checkedPhase === "before_ask" ? "denied" : error instanceof CaptureStop ? error.status :
        error?.name === "DeniedError" || /reject|denied/i.test(error?.name ?? "") ? "denied" : "failed";
      turn.outcome = { status, reason: turn.reason ?? (error instanceof CaptureStop ? error.code :
        status === "denied" ? "native_permission_denied" : "commit_failed") };
      return { status: status === "denied" ? "denied" : "blocked", error: { code: turn.outcome.reason } };
    } finally { context.abort.removeEventListener("abort", aborted); }
  }
  function execute(args, context) {
    const worker = lifecycle.workers.get(context.sessionID);
    const pending = executeBound(args, context);
    if (worker && !worker.closed && !worker.turn.commitPending) worker.turn.commitPending = pending;
    return pending;
  }
  return { ...createCaptureInputGuard(lifecycle), params, before, execute, owns: (id) => lifecycle.workers.has(id) };
}
