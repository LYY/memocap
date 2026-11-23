import { createHash } from "node:crypto";
import { exactPlacement } from "../discovery.js";

export class MaintenanceError extends Error {
  constructor(code) { super(code); this.name = "MaintenanceError"; this.code = code; }
}

export function requireMaintenance(condition, code) {
  if (!condition) throw new MaintenanceError(code);
}

export function exactObject(input, keys) {
  requireMaintenance(input !== null && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key)), "invalid_request");
  return input;
}

export function parseText(input, max = 65536) {
  requireMaintenance(typeof input === "string" && input.length <= max && input.isWellFormed() && !input.includes("\0"), "invalid_request");
  return input;
}

export function parseName(input) {
  parseText(input, 2048);
  requireMaintenance(input.trim().length > 0, "invalid_request");
  return input;
}

export function parseID(input) {
  requireMaintenance(Number.isSafeInteger(input) && input > 0, "invalid_request");
  return input;
}

export function parseDigest(input) {
  requireMaintenance(typeof input === "string" && /^[a-f0-9]{64}$/.test(input), "invalid_request");
  return input;
}

export function parsePlacement(input) {
  parseName(input);
  requireMaintenance(exactPlacement(input), "invalid_request");
  return input;
}

export function parseDatabase(input) {
  parseName(input);
  requireMaintenance(!/[*?]/u.test(input), "invalid_request");
  return input;
}

export function parseTask(input) {
  exactObject(input, ["parentID", "taskID", "epoch"]);
  parseName(input.parentID); parseName(input.taskID);
  requireMaintenance(Number.isSafeInteger(input.epoch) && input.epoch >= 0, "invalid_request");
  return taskOf(input);
}

export function parseCaller(input) {
  exactObject(input, ["parentID", "taskID", "epoch", "sessionID", "messageID", "callID"]);
  parseTask(taskOf(input));
  [input.sessionID, input.messageID, input.callID].forEach(parseName);
  requireMaintenance(input.sessionID === input.parentID, "invalid_request");
  return structuredClone(input);
}

export function parseSnapshot(input) {
  exactObject(input, ["id", "placement", "scope", "content", "kind", "tags", "topic_key", "created_at", "updated_at", "organized_at", "provenance"]);
  parseID(input.id); parsePlacement(input.placement);
  [input.scope, input.content, input.kind, input.tags, input.topic_key, input.created_at, input.updated_at].forEach((entry) => { parseText(entry); });
  if (input.organized_at !== null) parseText(input.organized_at);
  if (input.provenance !== null) {
    const origin = exactObject(input.provenance, ["memory_id", "source_memory_id", "source_placement_kind", "source_repository_id",
      "source_domain_id", "action", "operation_id", "created_at", "applicability_note"]);
    parseID(origin.memory_id); parseID(origin.source_memory_id);
    requireMaintenance(["repository", "domain", "universal"].includes(origin.source_placement_kind) && ["copy", "move"].includes(origin.action), "invalid_request");
    [origin.operation_id, origin.created_at].forEach((entry) => { parseText(entry); });
    [origin.source_repository_id, origin.source_domain_id, origin.applicability_note].forEach((entry) => { if (entry !== null) parseText(entry); });
  }
  return structuredClone(input);
}

export const hash = (content) => createHash("sha256").update(content, "utf8").digest("hex");
export const fingerprint = (input) => hash(JSON.stringify(input));
export const taskOf = ({ parentID, taskID, epoch }) => ({ parentID, taskID, epoch });
export const sameTask = (left, right) => left.parentID === right.parentID && left.taskID === right.taskID && left.epoch === right.epoch;
export const recordKey = ({ id, placement }) => JSON.stringify([id, placement]);

export function immutable(input) {
  if (input && typeof input === "object") {
    Object.values(input).forEach(immutable);
    Object.freeze(input);
  }
  return input;
}
