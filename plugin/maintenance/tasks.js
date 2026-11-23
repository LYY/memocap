import { randomUUID } from "node:crypto";
import { clean } from "../capture/observed/value.js";
import { readFrame } from "../capture/sources/read.js";
import { fingerprint, hash, immutable, requireMaintenance } from "./boundary.js";

export function createMaintenanceTasks(cancel, frames) {
  const parents = new Map();
  const workers = new Map();
  const calls = new Map();
  let epoch = 0;
  function invalidate(turn, reason) {
    if (!turn) return;
    turn.observation?.abort();
    frames.drop(turn.task.parentID);
    delete turn.prior;
    if (turn.phase === "dispatched" || turn.phase === "finished") { cancel(turn.task); return; }
    turn.reason ??= reason;
    turn.controller.abort();
    cancel(turn.task);
    for (const [key, queue] of calls) {
      const retained = queue.filter((entry) => entry.turn !== turn);
      if (retained.length) calls.set(key, retained); else calls.delete(key);
    }
  }
  function check(turn) {
    requireMaintenance(parents.get(turn.task.parentID) === turn && !turn.reason && !turn.controller.signal.aborted, turn.reason ?? "task_changed");
  }
  function observe(input, output) {
    if (workers.has(input.sessionID) || output.message.role !== "user" ||
      !output.parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored && !part.metadata?.memocap && part.text.trim())) return;
    const previous = parents.get(input.sessionID);
    if (previous?.userID === output.message.id) return;
    const prior = frames.take(input.sessionID);
    invalidate(previous, "new_input");
    const task = { parentID: input.sessionID, taskID: randomUUID(), epoch: ++epoch };
    const turn = { task, userID: output.message.id, agent: input.agent ?? output.message.agent,
      model: input.model ?? output.message.model, controller: new AbortController(), phase: "observed", used: [], evidence: new Map(),
      messages: new Map(), toolStates: new Map(), model_calls: 0, tool_calls: 0, write_attempts: 0, children: [], prior };
    parents.set(input.sessionID, turn);
    if (parents.size > 64) { const oldest = parents.keys().next().value; invalidate(parents.get(oldest), "evicted"); parents.delete(oldest); }
    const parts = output.parts.filter((part) => part.type === "text" && !part.synthetic && !part.ignored && !part.metadata?.memocap);
    if (!clean(parts) || !clean(parts.map((part) => part.text).join(""))) { invalidate(turn, "evidence_unavailable"); return; }
    for (const part of parts) {
      retain(turn, part.id, part.text.replace(/\r\n?/g, "\n"), "source", "observed");
    }
  }
  function retain(turn, sourceID, text, kind, outcome) {
    if (typeof text !== "string" || text.length > 16384 || !clean(text)) { invalidate(turn, "evidence_unavailable"); return; }
    turn.evidence.set(sourceID, immutable({ source_id: sourceID, task: turn.task, kind, outcome,
      completeness: "full", text, content_hash: hash(text) }));
    if (turn.evidence.size > 12 || Buffer.byteLength(JSON.stringify([...turn.evidence.values()])) > 32768) invalidate(turn, "input_budget");
  }
  function event({ event }) {
    const props = event.properties;
    const id = props.sessionID ?? props.info?.sessionID ?? props.part?.sessionID ?? props.info?.id;
    const owner = workers.get(id)?.turn ?? parents.get(id);
    if (workers.get(id)?.closed) return;
    if (event.type === "session.updated" && props.info?.permission && owner?.permissionSnapshots?.has(id) &&
      fingerprint(props.info.permission) !== owner.permissionSnapshots.get(id)) invalidate(owner, "permission_changed");
    if (workers.has(id)) {
      if (["session.error", "session.deleted"].includes(event.type)) invalidate(workers.get(id).turn, "worker_signal");
      return;
    }
    const turn = parents.get(id);
    if (!turn) return;
    if (["session.error", "session.deleted", "session.compacted"].includes(event.type)) invalidate(turn, "parent_signal");
    if (event.type === "message.updated") {
      const info = props.info;
      if (info.id === turn.userID && info.role !== "user") invalidate(turn, "source_changed");
      if (info.role === "assistant" && info.parentID === turn.userID) {
        const previous = turn.messages.get(info.id);
        if (!previous?.completed || info.time?.completed >= previous.completed) turn.messages.set(info.id,
          { role: info.role, parentID: info.parentID, finish: info.finish, error: Boolean(previous?.error || info.error), completed: info.time?.completed });
        else if (info.error) previous.error = true;
        if (turn.messages.size > 24) invalidate(turn, "input_budget");
      }
    }
    if (["message.part.removed", "message.removed"].includes(event.type)) invalidate(turn, "source_changed");
    if (event.type === "message.part.updated") {
      const part = props.part;
      if (part.messageID === turn.userID) {
        const original = turn.evidence.get(part.id);
        if (!original && (part.synthetic || part.ignored || part.metadata?.memocap)) return;
        if (!original || part.type !== "text" || part.synthetic || part.ignored || part.metadata?.memocap || !clean(part) ||
          hash(part.text.replace(/\r\n?/g, "\n")) !== original.content_hash) invalidate(turn, "source_changed");
        return;
      }
      const message = turn.messages.get(part.messageID);
      if (!message || message.parentID !== turn.userID) return;
      if (part.synthetic || part.ignored || part.metadata?.memocap) { if (turn.evidence.has(part.id)) invalidate(turn, "source_changed"); return; }
      if (part.type !== "tool") return;
      if (turn.evidence.has(part.id) && !clean(part)) { invalidate(turn, "source_changed"); return; }
      const state = part.state;
      const previous = turn.toolStates.get(part.id);
      if (previous?.status === "error" || previous?.end && (!state.time?.end || state.time.end < previous.end)) return;
      turn.toolStates.set(part.id, { status: state.status, end: state.time?.end });
      if (turn.toolStates.size > 64) invalidate(turn, "input_budget");
      if (!["read", "bash"].includes(part.tool)) return;
      if (state.status === "error") { retain(turn, part.id, state.error, "validation", "missing"); return; }
      if (state.status !== "completed" || !Number.isSafeInteger(state.time?.end) || !clean(part)) return;
      if (part.tool === "read") {
        const frame = readFrame(state);
        if (frame) retain(turn, part.id, frame.text, "source", "observed");
        else invalidate(turn, "evidence_unavailable");
      } else if (state.metadata?.truncated === false && Number.isSafeInteger(state.metadata.exit) && typeof state.metadata.output === "string") {
        const outcome = state.metadata.exit === 0 && !/\b(?:404|ETIMEDOUT|ECONNREFUSED|permission denied|offline)\b/i.test(state.output) ? "observed" : "missing";
        retain(turn, part.id, state.output.replace(/\r\n?/g, "\n"), "validation", outcome);
      } else invalidate(turn, "evidence_unavailable");
    }
  }
  function before(input, output) {
    const turn = parents.get(input.sessionID);
    if (!turn || workers.has(input.sessionID) || !["memocap_read", "memocap_maintain"].includes(input.tool)) return;
    const key = JSON.stringify([input.sessionID, input.tool, fingerprint(output.args)]);
    const queue = calls.get(key) ?? [];
    requireMaintenance(queue.length < 8 && calls.size < 128, "input_budget");
    queue.push({ turn, callID: input.callID }); calls.set(key, queue);
  }
  function caller(context, tool, args) {
    const key = JSON.stringify([context.sessionID, tool, fingerprint(args)]);
    const queue = calls.get(key);
    const entry = queue?.shift();
    if (!queue?.length) calls.delete(key);
    requireMaintenance(entry, "native_call_required");
    check(entry.turn);
    return { turn: entry.turn, caller: { ...entry.turn.task, sessionID: context.sessionID, messageID: context.messageID, callID: entry.callID } };
  }
  return { parents, workers, check, invalidate, observe, event, before, caller,
    sourceHash: (turn) => fingerprint([...turn.evidence.values()]),
    complete(turn) { const messages = [...turn.messages.values()]; const last = messages.at(-1);
      return last?.finish === "stop" && Boolean(last.completed) && messages.every((message) => !message.error) &&
        [...turn.toolStates.values()].every((tool) => ["completed", "error"].includes(tool.status)); },
    dispose() { for (const turn of parents.values()) invalidate(turn, "disposed"); parents.clear(); workers.clear(); calls.clear(); frames.clear(); } };
}
