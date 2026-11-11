import { CaptureStop } from "./contract.js";

export function createLifecycle(abort) {
  const parents = new Map();
  const workers = new Map();
  let generation = 0;
  function invalidate(turn, reason) {
    if (!turn || turn.phase === "writing" || turn.phase === "finished" || turn.reason) return;
    turn.reason = reason;
    turn.controller.abort();
    for (const childID of turn.children) abort(childID);
  }
  function observe(input, output) {
    if (workers.has(input.sessionID) || output.message.role !== "user" ||
        !output.parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim())) return;
    const previous = parents.get(input.sessionID);
    if (previous?.userID === output.message.id) return;
    invalidate(previous, "new_input");
    const turn = { parentID: input.sessionID, userID: output.message.id, agent: input.agent ?? output.message.agent,
      model: input.model ?? output.message.model, generation: ++generation,
      phase: "observed", children: [], controller: new AbortController(), model_calls: 0, tool_calls: 0, write_attempts: 0 };
    parents.delete(input.sessionID);
    parents.set(input.sessionID, turn);
    if (parents.size > 128) {
      const oldest = parents.keys().next().value;
      invalidate(parents.get(oldest), "evicted");
      parents.delete(oldest);
    }
  }
  function check(turn) {
    if (turn.reason || parents.get(turn.parentID) !== turn) throw new CaptureStop(turn.reason ?? "new_input");
  }
  function event(event) {
    const id = event.properties.sessionID ?? event.properties.info?.id;
    const worker = workers.get(id);
    if (worker) {
      if (event.type === "session.deleted" && worker.closed) workers.delete(id);
      if (["session.error", "session.deleted"].includes(event.type)) invalidate(worker.turn, "worker_signal");
      return;
    }
    const turn = parents.get(id);
    if (!turn) return;
    switch (event.type) {
      case "session.status":
        if (event.properties.status.type === "idle") {
          if (turn.phase !== "observed") { invalidate(turn, "ambiguous_idle"); return; }
          turn.phase = "checking";
          return turn;
        }
        if (event.properties.status.type === "retry") invalidate(turn, "parent_retry");
        else if (turn.phase !== "observed") invalidate(turn, "parent_busy");
        break;
      case "session.error": invalidate(turn, "parent_error"); break;
      case "session.deleted": invalidate(turn, "parent_deleted"); parents.delete(id); break;
      default: break;
    }
  }
  return { parents, workers, observe, event, check, invalidate,
    worker(id, turn, stage) {
      turn.children.push(id);
      if (workers.size >= 256) {
        const closed = [...workers].find(([, worker]) => worker.closed);
        if (closed) workers.delete(closed[0]);
        else { invalidate(turn, "worker_capacity"); check(turn); }
      }
      workers.set(id, { turn, stage });
    },
    finish(turn) {
      turn.phase = "finished";
      for (const id of turn.children) {
        const worker = workers.get(id);
        if (worker) worker.closed = true;
      }
    },
    writing(turn) { check(turn); turn.phase = "writing"; turn.write_attempts = 1; },
    dispose() { for (const turn of parents.values()) invalidate(turn, "disposed"); parents.clear(); } };
}
