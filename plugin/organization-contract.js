import { isDeepStrictEqual } from "node:util";
import { tool } from "@opencode-ai/plugin";
import { validateReceipt } from "./protocol.js";

const schema = tool.schema;
const id = schema.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bound = schema.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const placement = schema.string().min(1);
const key = schema.object({ id, placement }).strict();
const nullableText = schema.string().nullable();
const provenance = schema.object({ memory_id: id, source_memory_id: id,
  source_placement_kind: schema.enum(["repository", "domain", "universal"]),
  source_repository_id: nullableText, source_domain_id: nullableText, action: schema.enum(["copy", "move"]),
  operation_id: schema.string(), created_at: schema.string(), applicability_note: nullableText }).strict();
const snapshot = schema.object({ id, placement, scope: schema.string(), content: schema.string(),
  kind: schema.string(), tags: schema.string(), topic_key: schema.string(), created_at: schema.string(),
  updated_at: schema.string(), organized_at: nullableText, provenance: provenance.nullable() }).strict();
const content = schema.string().refine((text) => text.trim().length > 0);
const group = schema.discriminatedUnion("action", [
  schema.object({ action: schema.literal("keep"), expected: snapshot }).strict(),
  schema.object({ action: schema.literal("delete"), expected: snapshot }).strict(),
  schema.object({ action: schema.literal("refine"), expected: snapshot, content }).strict(),
  schema.object({ action: schema.literal("merge"), survivor: snapshot,
    sources: schema.array(snapshot).min(1), content }).strict(),
]);
const requests = {
  page: schema.object({ selection: schema.enum(["pending", "all", "organized-reference"]).optional(),
    after_id: id.nullable().optional(), upper_id: bound.nullable().optional() }).strict(),
  read: schema.object({ keys: schema.array(key).min(1) }).strict(),
  apply: schema.object({ mode: schema.enum(["pending", "all"]), group,
    dependencies: schema.array(snapshot) }).strict(),
};
const payloads = {
  page: schema.object({ database: schema.string(), selection: schema.enum(["pending", "all", "organized-reference"]),
    upper_id: bound, next_id: id.nullable(), exhausted: schema.boolean(), records: schema.array(snapshot).max(20) }).strict(),
  read: schema.object({ database: schema.string(), records: schema.array(key.extend({ snapshot: snapshot.nullable() })) }).strict(),
  apply: schema.object({ database: schema.string(), action: schema.enum(["keep", "refine", "merge", "delete"]),
    records: schema.array(snapshot), deleted: schema.array(key) }).strict(),
};

export function organizationError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, outcome: "not_started", ...details });
}

export const recordKey = ({ id, placement }) => ({ id, placement });
export const keyToken = (record) => JSON.stringify(recordKey(record));
export function participants(request) {
  return request.group.action === "merge" ? [request.group.survivor, ...request.group.sources] : [request.group.expected];
}

export function parseOrganizationRequest(operation, raw) {
  let request;
  try { request = JSON.parse(raw); }
  catch { throw organizationError("invalid_request", "request must be one JSON object"); }
  const parsed = Object.hasOwn(requests, operation) && requests[operation].safeParse(request);
  if (!parsed?.success) throw organizationError("invalid_request", "Invalid organization request shape");
  if (operation === "page" && request.after_id != null && request.upper_id == null) {
    throw organizationError("invalid_request", "after_id requires upper_id");
  }
  const keys = operation === "apply" ? [...participants(request), ...request.dependencies]
    : operation === "read" ? request.keys : [];
  if (new Set(keys.map((record) => operation === "apply" ? record.id : keyToken(record))).size !== keys.length || (operation === "apply" &&
      new Set(participants(request).map((record) => record.placement)).size !== 1)) {
    throw organizationError("invalid_request", "Participants and dependencies must be unique; merge uses one placement");
  }
  return request;
}

export function approvedPostconditions(request, post) {
  const group = request.group;
  const original = group.action === "merge" ? group.survivor : group.expected;
  const deleted = group.action === "delete" ? [recordKey(original)] : group.action === "merge" ? group.sources.map(recordKey) : [];
  if (post.action !== group.action || post.records.length !== (group.action === "delete" ? 0 : 1) ||
      !sameKeys(post.deleted, deleted)) return false;
  if (group.action === "delete") return true;
  const survivor = post.records[0];
  if (typeof survivor.organized_at !== "string" || !survivor.organized_at) return false;
  const approved = { ...original, organized_at: survivor.organized_at };
  if (group.action !== "keep") Object.assign(approved, { content: group.content, updated_at: survivor.updated_at });
  return isDeepStrictEqual(approved, survivor);
}

function sameKeys(actual, expected) {
  return actual.length === expected.length && new Set(actual.map(keyToken)).size === actual.length &&
    actual.every((record) => expected.some((key) => keyToken(record) === keyToken(key)));
}

export function validateOrganizationReceipt(receipt, frozen) {
  const invalid = () => { throw organizationError("invalid_receipt", "Invalid organization receipt", { receipt, outcome: "outcome_unknown" }); };
  try { validateReceipt(receipt); }
  catch (error) {
    if (error.code === "cli_failed" && receipt.operation === `organize_${frozen.operation}` && receipt.backend === "local" &&
        !receipt.targets.length && !receipt.results.length && !receipt.returned_ids.length && receipt.activity_status === "not_requested" &&
        ["failed", "rejected"].includes(receipt.status) && ["not_started", "rolled_back"].includes(receipt.outcome) &&
        typeof receipt.error?.code === "string" && typeof receipt.error.message === "string") {
      throw organizationError("cli_failed", "Organization request failed", { receipt, outcome: receipt.outcome });
    }
    invalid();
  }
  const parsed = payloads[frozen.operation].safeParse(receipt.organization);
  if (!parsed.success || receipt.operation !== `organize_${frozen.operation}` || receipt.backend !== "local" ||
      receipt.targets.length || receipt.results.length || receipt.activity_status !== "not_requested" ||
      receipt.organization.database !== frozen.database) invalid();
  const payload = receipt.organization;
  if (frozen.operation === "page") {
    const empty = payload.records.length === 0;
    const requested = frozen.request;
    if (receipt.status !== (empty ? "empty" : "ok") || payload.exhausted !== empty ||
        payload.next_id !== (empty ? null : payload.records.at(-1).id) ||
        payload.selection !== (requested.selection ?? "pending") ||
        (requested.upper_id != null && payload.upper_id !== requested.upper_id) ||
        payload.records.some((record, index) => record.id > payload.upper_id || record.id <= (requested.after_id ?? 0) ||
          (index > 0 && record.id <= payload.records[index - 1].id) ||
          (payload.selection === "pending" && record.organized_at !== null) ||
          (payload.selection === "organized-reference" && record.organized_at === null))) invalid();
  } else if (frozen.operation === "read") {
    if (receipt.status !== "ok" || payload.records.length !== frozen.request.keys.length ||
        payload.records.some((record, index) => keyToken(record) !== keyToken(frozen.request.keys[index]) ||
          (record.snapshot !== null && keyToken(record.snapshot) !== keyToken(record)))) invalid();
  } else if (receipt.status !== "ok" || receipt.outcome !== "committed") invalid();
  const returned = payload.records.filter((record) => frozen.operation !== "read" || record.snapshot !== null).map((record) => record.id);
  if (JSON.stringify(returned) !== JSON.stringify(receipt.returned_ids)) invalid();
  return receipt;
}
