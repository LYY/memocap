import { bytes } from "./value.js";

export function createRetention(sessions) {
  const maxima = {};
  return () => {
    const all = [...sessions.values()].flat();
    const messages = all.flatMap((turn) => turn.messages);
    const parts = messages.flatMap((message) => message.parts);
    const largest = (values) => Math.max(0, ...values);
    const current = {
      bytes: sessions.size ? bytes([...sessions]) : 0,
      sessions: sessions.size, turns: all.length, messages: messages.length, parts: parts.length,
      evidenceParts: parts.filter((part) => part.value).length,
      sessionTurns: largest([...sessions.values()].map((entries) => entries.length)),
      sessionBytes: largest([...sessions].map((entry) => bytes(entry))),
      turnMessages: largest(all.map((turn) => turn.messages.length)),
      turnParts: largest(all.map((turn) => turn.messages.reduce((sum, message) => sum + message.parts.length, 0))),
      turnBytes: largest(all.map((turn) => bytes(turn))),
      messageParts: largest(messages.map((message) => message.parts.length)),
      messageBytes: largest(messages.map((message) => bytes(message))),
      partBytes: largest(parts.map((part) => part.value ? bytes(part.value) : 0)),
    };
    for (const [key, value] of Object.entries(current)) maxima[key] = Math.max(maxima[key] ?? 0, value);
    return { ...current, maxima: { ...maxima } };
  };
}
