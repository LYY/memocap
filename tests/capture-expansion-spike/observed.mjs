export const profile = Object.freeze({ turns: 8, sessions: 4, messages: 16, parts: 24,
  partBytes: 8192, turnBytes: 32768, globalBytes: 131072, ttlMs: 120000 });

export function createObserved(report) {
  const sessions = new Map();
  let dropped = 0;
  let maxima = { bytes: 0, turns: 0, partBytes: 0 };
  const size = (value) => Buffer.byteLength(JSON.stringify(value));
  function measure() {
    const turns = [...sessions.values()].flat();
    const bytes = size(turns);
    maxima = { bytes: Math.max(maxima.bytes, bytes), turns: Math.max(maxima.turns, turns.length),
      partBytes: Math.max(maxima.partBytes, ...turns.flatMap((turn) => turn.messages.flatMap((message) => message.parts.map(size))), 0) };
    return { bytes, turns: turns.length };
  }
  function trim() {
    for (const [id, turns] of sessions) {
      const live = turns.filter((turn) => Date.now() - turn.observed < profile.ttlMs).slice(-profile.turns);
      if (live.length) sessions.set(id, live); else sessions.delete(id);
    }
    while (sessions.size > profile.sessions || size([...sessions.values()].flat()) > profile.globalBytes) {
      sessions.delete(sessions.keys().next().value);
    }
    measure();
  }
  function put(message, part) {
    if (part.synthetic || part.ignored || part.metadata?.memocap) return;
    const previous = message.parts.findIndex((entry) => entry.id === part.id);
    if (previous >= 0) message.parts.splice(previous, 1);
    if (size(part) > profile.partBytes) {
      dropped++;
      if (part.type === 'tool' && message.parts.length < profile.parts) message.parts.push({ id: part.id, sessionID: part.sessionID,
        messageID: part.messageID, type: part.type, tool: part.tool, callID: part.callID,
        state: { status: part.state.status, time: part.state.time } });
      return;
    }
    if (message.parts.length < profile.parts) message.parts.push(structuredClone(part));
  }
  function observe(input, output) {
    if (output.message.role !== 'user' || !output.parts.some((part) => part.type === 'text' && !part.synthetic && !part.ignored)) return;
    const turns = sessions.get(input.sessionID) ?? [];
    const user = { info: structuredClone(output.message), parts: [] };
    for (const part of output.parts) put(user, part);
    turns.push({ id: output.message.id, observed: Date.now(), messages: [user] });
    if (size(turns.at(-1)) > profile.turnBytes) { turns.pop(); dropped++; }
    sessions.delete(input.sessionID);
    sessions.set(input.sessionID, turns);
    trim();
  }
  function event(event) {
    const properties = event.properties;
    const id = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID ?? properties.info?.id;
    const turns = sessions.get(id);
    if (!turns) return;
    if (['session.error', 'session.deleted'].includes(event.type)) { sessions.delete(id); return; }
    const turn = turns.at(-1);
    if (event.type === 'message.updated') {
      const info = properties.info;
      if (info.role !== 'assistant' || info.parentID !== turn.id) return;
      const message = turn.messages.find((entry) => entry.info.id === info.id);
      if (message) message.info = structuredClone(info);
      else if (turn.messages.length < profile.messages) turn.messages.push({ info: structuredClone(info), parts: [] });
    }
    if (event.type === 'message.part.updated') {
      const part = properties.part;
      const message = turn.messages.find((entry) => entry.info.id === part.messageID);
      if (message) put(message, part);
    }
    if (size(turn) > profile.turnBytes) { turn.messages = turn.messages.slice(0, 1); dropped++; }
    trim();
  }
  function snapshot(id, userID) {
    trim();
    const turn = sessions.get(id)?.find((entry) => entry.id === userID);
    const messages = turn?.messages ?? [];
    report({ phase: 'spike.snapshot', sessionID: id, userID, profile, retained: measure(), maxima,
      dropped, messages: structuredClone(messages), bytes: size(messages) });
    return structuredClone(messages);
  }
  return { observe, event, snapshot };
}
