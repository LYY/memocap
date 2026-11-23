import { CaptureStop, complete } from "./contract.js";
import { fullReadConstraint } from './constraints.js';
import { createRetention } from "./observed/retention.js";
import { bytes, clean, identifier, messageInfo, observedPart } from "./observed/value.js";

export const observedCandidateProfile = Object.freeze({ turns: 8, sessions: 4, messages: 16, parts: 24,
  partBytes: 8192, turnBytes: 32768, globalBytes: 131072, ttlMs: 120000 });
export const observedProfileStatus = "spike_measured_candidate_not_final_tuned";
const systemClock = { now: Date.now, setTimeout, clearTimeout };

export function createObserved({ profile: selected = {}, clock = systemClock, onMeasure } = {}) {
  const profile = Object.freeze({ ...observedCandidateProfile, ...selected });
  if (Object.keys(profile).some((key) => !Object.hasOwn(observedCandidateProfile, key) ||
      !Number.isSafeInteger(profile[key]) || profile[key] <= 0) || profile.ttlMs > 2147483647) {
    throw new CaptureStop("observed_profile", "failed");
  }
  const sessions = new Map();
  let timer;
  let closed = false;
  const measure = createRetention(sessions);
  const turns = () => [...sessions.values()].flat();
  function trim() {
    clock.clearTimeout(timer);
    for (const [id, entries] of sessions) {
      const live = entries.filter((turn) => clock.now() - turn.at < profile.ttlMs).slice(-profile.turns);
      if (live.length) sessions.set(id, live); else sessions.delete(id);
    }
    while (sessions.size && (sessions.size > profile.sessions || bytes([...sessions]) > profile.globalBytes)) sessions.delete(sessions.keys().next().value);
    const retained = measure();
    onMeasure?.(retained);
    const next = Math.min(...turns().map((turn) => turn.at + profile.ttlMs));
    if (!closed && Number.isFinite(next)) {
      timer = clock.setTimeout(trim, Math.max(1, next - clock.now()));
      timer?.unref?.();
    }
  }
  function bound(id, turn) {
    if (bytes(turn) > profile.turnBytes) {
      turn.blocked = true;
      turn.constraints = [];
      turn.messages = [{ info: { id: turn.userID, role: "user" }, parts: [] }];
      if (bytes(turn) > profile.turnBytes) sessions.set(id, sessions.get(id).filter((entry) => entry !== turn));
    }
    trim();
  }
  function put(turn, message, part) {
    if (message.info.role === "assistant" && part.type !== "tool") return;
    if (message.info.role === "user" && part.type !== "text") return;
    const previous = message.parts.find((entry) => entry.id === part.id);
    let projected = observedPart(part, profile.partBytes, previous?.omitted || message.omitted || !message.info.role);
    if (!projected) { if (part.type === "tool") turn.blocked = true; return; }
    if (!previous && message.parts.length >= profile.parts) { turn.blocked = true; return; }
    if (message.info.role === "user") {
      const fragments = message.parts.map((entry) => entry.id === part.id ? projected.value?.text : entry.value?.text);
      if (!previous) fragments.push(projected.value?.text);
      if (projected.omitted || !clean(fragments.join(""))) {
        message.omitted = true;
        message.parts = message.parts.map((entry) => ({ id: entry.id, omitted: true }));
        projected = { omitted: true };
      }
    }
    const terminal = (value) => ["completed", "error"].includes(value?.state?.status);
    if (terminal(previous?.value) && (!terminal(projected.value) || previous.value.state.status === "error")) {
      projected = observedPart(previous.value, profile.partBytes, previous.omitted || projected.omitted);
    }
    const entry = { id: part.id, ...projected };
    if (previous) message.parts.splice(message.parts.findIndex((retained) => retained.id === part.id), 1, entry); else message.parts.push(entry);
  }
  function observe(input, output) {
    if (closed || !identifier(input.sessionID) || output.message.role !== "user" ||
        !output.parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored && !part.metadata?.memocap && part.text.trim())) return;
    const info = messageInfo(output.message);
    if (!info) return;
    const entries = sessions.get(input.sessionID) ?? [];
    if (entries.at(-1)?.userID === info.id) return;
    const text = output.parts.filter((part) => part.type === "text" && !part.synthetic && !part.ignored && !part.metadata?.memocap).map((part) => part.text).join("");
    const turn = { userID: info.id, at: clock.now(), updatedAt: clock.now(), blocked: false, constraints: [], messages: [{ info, omitted: !clean(text), parts: [] }] };
    for (const part of output.parts) put(turn, turn.messages[0], part);
    entries.push(turn);
    sessions.delete(input.sessionID);
    sessions.set(input.sessionID, entries);
    bound(input.sessionID, turn);
  }
  function event(event) {
    if (closed) return;
    const properties = event.properties;
    const id = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID ?? properties.info?.id;
    if (["session.error", "session.deleted", "message.removed", "message.part.removed"].includes(event.type)) { clear(id); return; }
    trim();
    const entries = sessions.get(id) ?? [];
    const partID = properties.part?.messageID;
    const infoID = properties.info?.id;
    const turn = entries.find((entry) => entry.userID === partID || entry.messages.some((message) => message.info.id === (partID ?? infoID))) ?? entries.at(-1);
    if (!turn || turn.blocked) return;
    switch (event.type) {
      case "message.updated": {
        const raw = properties.info;
        if (raw.id === turn.userID) return;
        const previous = turn.messages.find((entry) => entry.info.id === raw.id);
        if (raw.role !== "assistant" || raw.parentID !== turn.userID) {
          if (previous) turn.messages.splice(turn.messages.indexOf(previous), 1);
          return;
        }
        const info = messageInfo(raw);
        if (!info) { turn.blocked = true; break; }
        if (previous) {
          const failed = previous.info.error || raw.error;
          if (!previous.info.time?.completed || info.time.completed >= previous.info.time.completed) previous.info = info;
          if (failed) previous.info.error = true;
        } else if (turn.messages.length < profile.messages) turn.messages.push({ info, parts: [] });
        else turn.blocked = true;
        break;
      }
      case "message.part.updated": {
        const part = properties.part;
        if (!identifier(part.messageID)) { turn.blocked = true; break; }
        let message = turn.messages.find((entry) => entry.info.id === part.messageID);
        if (!message) {
          if (turn.messages.length >= profile.messages) { turn.blocked = true; break; }
          message = { info: { id: part.messageID }, parts: [] };
          turn.messages.push(message);
        }
        put(turn, message, part);
        break;
      }
      default: return;
    }
    turn.updatedAt = clock.now();
    bound(id, turn);
  }
  function project(turn) {
    if (!turn || turn.blocked || turn.messages.some((message) => !message.info.role)) return [];
    const [user, ...messages] = turn.messages;
    messages.sort((left, right) => (left.info.time.created ?? 0) - (right.info.time.created ?? 0) || left.info.id.localeCompare(right.info.id));
    return structuredClone([user, ...messages].map((message) => ({ info: message.info,
      parts: message.parts.flatMap((part) => part.value ? [part.value] : []) })));
  }
  function snapshot(id, userID) {
    trim();
    const turn = sessions.get(id)?.at(-1);
    return turn?.userID === userID ? project(turn) : [];
  }
  function bind(id, userID, origin) {
    const turn = sessions.get(id)?.at(-1);
    if (turn?.userID === userID && clean(origin)) turn.origin = origin;
    if (turn) bound(id, turn);
  }
  function registerRead(receipt, requested, caller) {
    trim();
    const turn = sessions.get(caller.rootID)?.at(-1);
    if (!turn || turn.blocked || turn.userID !== caller.userID || !turn.messages.some((message) =>
      message.info.id === caller.messageID && message.info.role === 'assistant' && message.info.parentID === caller.userID)) return;
    const constraint = fullReadConstraint(receipt, requested, caller);
    if (!constraint) return;
    const previous = turn.constraints.find((entry) => entry.id === constraint.id && entry.placement === constraint.placement);
    if (bytes(constraint) > profile.partBytes || !previous && turn.constraints.length >= profile.parts ||
        previous && previous.content_hash !== constraint.content_hash) {
      turn.blocked = true;
      turn.constraints = [];
    } else {
      turn.constraints = turn.constraints.filter((entry) => entry !== previous).concat(constraint);
    }
    turn.updatedAt = clock.now();
    bound(caller.rootID, turn);
  }
  function frame(id, userID, origin) {
    trim();
    const entries = sessions.get(id) ?? [];
    if (entries.at(-1)?.userID !== userID) return [];
    return entries.filter((turn) => turn.userID === userID || turn.origin === origin && complete(project(turn), turn.userID))
      .map((turn) => ({ userID: turn.userID, at: turn.updatedAt, messages: project(turn),
        constraints: turn.userID === userID ? structuredClone(turn.constraints) : [] }));
  }
  function breakContinuity(id, userID) {
    if (sessions.get(id)?.at(-1)?.userID !== userID) return;
    sessions.set(id, sessions.get(id).slice(-1));
    delete sessions.get(id)[0].origin;
    trim();
  }
  function clear(id, userID) {
    if (!userID || sessions.get(id)?.at(-1)?.userID === userID) sessions.delete(id);
    trim();
  }
  return { observe, event, snapshot, bind, registerRead, frame, breakContinuity, clear, profile, stats() { trim(); return measure(); },
    dispose() { closed = true; clock.clearTimeout(timer); sessions.clear(); } };
}
