import { createHash } from "node:crypto";
import { clean } from "../screen.js";

export { clean } from "../screen.js";

export const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
export const observationHash = (messages) => createHash("sha256").update(JSON.stringify(messages)).digest("hex");
export const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const timestamp = (value) => Number.isFinite(value) && value > 0;

export function messageInfo(info) {
  if (!identifier(info.id)) return;
  const time = {};
  if (timestamp(info.time?.created)) time.created = info.time.created;
  if (timestamp(info.time?.completed)) time.completed = info.time.completed;
  switch (info.role) {
    case "user": return { id: info.id, role: "user" };
    case "assistant":
      if (!identifier(info.parentID)) return;
      return { id: info.id, role: "assistant", parentID: info.parentID, time,
        ...(info.finish === "stop" ? { finish: "stop" } : {}), ...(info.error ? { error: true } : {}) };
    default: return;
  }
}

export function observedPart(part, limit, omitted = false) {
  if (!identifier(part.id)) return;
  if (part.synthetic || part.ignored || part.metadata?.memocap) return { omitted: true };
  switch (part.type) {
    case "text":
      if (omitted || typeof part.text !== "string" || !clean(part) || bytes(part) > limit) return { omitted: true };
      return { value: { id: part.id, type: "text", text: part.text }, omitted: false };
    case "tool": {
      switch (part.state?.status) {
        case "pending": case "running": case "completed": case "error": break;
        default: return;
      }
      const time = {};
      if (timestamp(part.state.time?.start)) time.start = part.state.time.start;
      if (timestamp(part.state.time?.end)) time.end = part.state.time.end;
      const metadata = { id: part.id, type: "tool", state: { status: part.state.status, time } };
      if (bytes(metadata) > limit) return;
      if (omitted || !clean(part) || bytes(part) > limit) return { value: metadata, omitted: true };
      if (!['read', 'bash'].includes(part.tool) || !identifier(part.callID)) return { value: metadata, omitted: true };
      const details = part.state.metadata;
      const display = details?.display;
      const verified = details ? { ...(details.exit === undefined ? {} : { exit: details.exit }),
        ...(details.truncated === undefined ? {} : { truncated: details.truncated }),
        ...(typeof details.output === 'string' ? { output: details.output } : {}),
        ...(display ? { display: Object.fromEntries(['type', 'path', 'text', 'lineStart', 'lineEnd', 'totalLines', 'truncated']
          .filter((key) => display[key] !== undefined).map((key) => [key, display[key]])) } : {}) } : undefined;
      return { value: { ...metadata, tool: part.tool, callID: part.callID, state: { ...metadata.state,
        input: Object.fromEntries((part.tool === 'read' ? ['filePath', 'offset', 'limit'] : ['command', 'workdir'])
          .filter((key) => part.state.input?.[key] !== undefined).map((key) => [key, structuredClone(part.state.input[key])])),
        ...(typeof part.state.error === 'string' ? { error: part.state.error } : {}),
        ...(verified ? { metadata: verified } : {}),
        ...(typeof part.state.output === "string" ? { output: part.state.output } : {}) } }, omitted: false };
    }
    default: return;
  }
}
