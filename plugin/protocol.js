import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { discoveryValid, exactPlacement } from "./discovery.js";
import { contentHash } from "./references.js";
import { contextValid, repositoryID } from "./targets.js";

export { budgetChars, referenceBlock } from "./references.js";

export const { version: packageVersion } = createRequire(import.meta.url)("../package.json");
const statuses = new Set(["ok", "empty", "skipped", "failed", "inserted", "updated", "deleted", "rejected", "outcome_unknown"]);
const activityStatuses = new Set(["not_requested", "recorded", "duplicate", "failed"]);
const codes = new Set(["invalid_receipt", "timeout", "cancelled", "version_mismatch", "launcher_missing",
  "spawn_failed", "cli_failed", "output_limit", "cleanup_failed", "invalid_request", "runtime_missing", "runtime_incompatible"]);

export function failure(error) {
  if (error?.status === "blocked") return { status: "blocked", error: { code: error.code }, outcome: "not_started" };
  return { status: "failed", error: { code: codes.has(error.code) ? error.code : "operation_failed" },
    outcome: error.outcome ?? "not_started" };
}

export function validateReceipt(receipt) {
  const valid = receipt && receipt.format_version === 1 && receipt.package_version === packageVersion &&
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(receipt.operation_id) && typeof receipt.operation === "string" &&
    statuses.has(receipt.status) && ["local", "remote"].includes(receipt.backend) &&
    ["cli", "server", "plugin"].includes(receipt.origin) && Array.isArray(receipt.targets) &&
    receipt.targets.every((target) => target && (target.canonical_path === null || typeof target.canonical_path === "string") &&
      typeof target.repository_id === "string" && repositoryID.test(target.repository_id) && Array.isArray(target.placements)) &&
    Array.isArray(receipt.results) && Array.isArray(receipt.returned_ids) &&
    receipt.returned_ids.every(Number.isSafeInteger) &&
    activityStatuses.has(receipt.activity_status) &&
    (receipt.repository_context === undefined || contextValid(receipt.repository_context));
  if (!valid) throw Object.assign(new Error("Invalid CLI envelope"), { code: "invalid_receipt" });
  if (["failed", "rejected", "outcome_unknown"].includes(receipt.status)) {
    throw Object.assign(new Error("CLI operation failed"), { code: "cli_failed", receipt, outcome: receipt.status });
  }
  return receipt;
}

export function validateInventory(receipt) {
  validateReceipt(receipt);
  if (!receipt.results.every((entry) => Number.isSafeInteger(entry.memory?.id) && entry.memory.id > 0 &&
      typeof entry.memory.content === "string" && exactPlacement(entry.memory.placement) &&
      Number.isInteger(entry.source_order) && ["visible", "shadowed", "source"].includes(entry.visibility) &&
      Array.isArray(entry.applicable_repositories) && entry.applicable_repositories.every((repo) => typeof repo === "string")) ||
      receipt.returned_ids.length !== receipt.results.length ||
      receipt.results.some((entry, index) => entry.memory.id !== receipt.returned_ids[index])) {
    throw Object.assign(new Error("Invalid CLI memories"), { code: "invalid_receipt" });
  }
  return receipt;
}

export function validateMemories(receipt, discovery) {
  validateInventory(receipt);
  if (!discoveryValid(receipt.discovery) || (discovery && JSON.stringify(receipt.discovery) !== JSON.stringify(discovery)) ||
      receipt.results.some((entry) => !["visible", "source"].includes(entry.visibility) ||
        (entry.visibility === "source" && entry.applicable_repositories.length !== 0) ||
        (receipt.discovery.kind === "origins" && !receipt.discovery.placements.includes(entry.memory.placement)) ||
        (entry.content_hash !== undefined && entry.content_hash !== contentHash(entry.memory.content)) ||
        (entry.completeness !== undefined && entry.completeness !== "full"))) {
    throw Object.assign(new Error("Invalid recalled visibility"), { code: "invalid_receipt" });
  }
  return { ...receipt, results: receipt.results.map((entry) => ({ ...entry, completeness: "full", content_hash: contentHash(entry.memory.content) })) };
}

export function validateRead(receipt, requested) {
  validateInventory(receipt);
  if (receipt.operation !== "read" || receipt.results.length !== 1 || receipt.results[0].memory.id !== requested.id ||
      receipt.results[0].memory.placement !== requested.placement) {
    throw Object.assign(new Error("Invalid exact memory read"), { code: "invalid_receipt" });
  }
  const entry = receipt.results[0];
  const content_hash = contentHash(entry.memory.content);
  if ((entry.content_hash !== undefined && entry.content_hash !== content_hash) ||
      (entry.completeness !== undefined && entry.completeness !== "full")) {
    throw Object.assign(new Error("Invalid memory integrity"), { code: "invalid_receipt" });
  }
  return { ...receipt, record_changed: requested.content_hash !== undefined && requested.content_hash !== content_hash,
    results: [{ ...entry, completeness: "full", content_hash }] };
}

export { queryTerms } from "./query.js";

export function repoArgs(targets) {
  return ["--targets-json", JSON.stringify(targets)];
}

export function textPart(state, text, metadata) {
  return { id: `prt_${randomUUID()}`, sessionID: state.sessionID, messageID: state.messageID,
    type: "text", synthetic: true, text, metadata: { memocap: metadata } };
}
