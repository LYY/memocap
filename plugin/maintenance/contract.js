import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { participantIDs, validateMaintenanceDecision } from "./assessment.js";
import { exactObject, immutable, parseDatabase, parseName, parseSnapshot, parseTask, recordKey, requireMaintenance, sameTask } from "./boundary.js";
import { assertPermissionSnapshot } from "./permission.js";
import { createBoundedRegistry } from "./registry.js";
import { nativeRequest } from "./request.js";

export { validateMaintenanceDecision };

export function createMaintenanceRegistry({ usage, permissionGate, current, ...options }) {
  requireMaintenance(typeof usage?.getUse === "function" && typeof permissionGate?.consume === "function" && typeof current === "function", "invalid_request");
  requireMaintenance(options.ttlMs === undefined || options.ttlMs <= 30000, "invalid_limits");
  const proposals = createBoundedRegistry({ ttlMs: 30000, ...options });
  function freeze(input, context) {
    exactObject(context, ["task", "database", "use_ids", "evidence", "permission", "review"]);
    const task = parseTask(context.task);
    const database = parseDatabase(context.database);
    requireMaintenance(Array.isArray(context.use_ids) && context.use_ids.length > 0 && context.use_ids.length <= 3 &&
      new Set(context.use_ids).size === context.use_ids.length, "input_budget");
    const used = context.use_ids.map((handle) => usage.getUse(handle, task));
    requireMaintenance(used.every((entry) => entry.database === database) && new Set(used.map((entry) => recordKey(entry.snapshot))).size === used.length, "reference_mismatch");
    const validated = validateMaintenanceDecision(input, { used, evidence: context.evidence });
    const decision = validated.decision;
    const mutating = ["update", "merge", "delete"].includes(decision.action);
    const target = mutating ? { database, operation: decision.action, participants: participantIDs(decision).map((handle) => {
      const { id, placement } = used.find((entry) => entry.use_id === handle).snapshot;
      return { id, placement };
    }) } : null;
    if (mutating) assertPermissionSnapshot(context.permission, target);
    let review_status = "unknown";
    if (context.review !== null) {
      exactObject(context.review, ["status", "decision_fingerprint", "evidence_fingerprint"]);
      requireMaintenance(["supported", "unsupported", "unknown"].includes(context.review.status) &&
        context.review.decision_fingerprint === validated.decision_fingerprint && context.review.evidence_fingerprint === validated.evidence_fingerprint, "review_mismatch");
      review_status = context.review.status;
    }
    const proposal_id = randomUUID();
    proposals.put({ proposal_id, task, database, target, used, decision, evidence: validated.evidence, review_status,
      permission_fingerprint: mutating ? context.permission.fingerprint : null }, proposal_id);
    return proposals.get(proposal_id);
  }
  function consume(proposalID) {
    parseName(proposalID);
    const proposal = proposals.get(proposalID);
    proposals.drop(proposalID);
    requireMaintenance(["update", "merge", "delete"].includes(proposal.decision.action), "no_mutation");
    requireMaintenance(proposal.review_status === "supported", "assessment_required");
    const observed = current();
    requireMaintenance(sameTask(parseTask(observed.task), proposal.task), "task_mismatch");
    requireMaintenance(parseDatabase(observed.database) === proposal.database, "database_changed");
    requireMaintenance(Array.isArray(observed.records) && observed.records.length === proposal.used.length, "snapshot_changed");
    const records = observed.records.map(parseSnapshot);
    requireMaintenance(proposal.used.every((entry) => isDeepStrictEqual(usage.getUse(entry.use_id, proposal.task), entry) &&
      records.some((record) => isDeepStrictEqual(record, entry.snapshot))), "snapshot_changed");
    permissionGate.consume(observed.authorization, proposal, observed.permission);
    return immutable({ proposal_id: proposalID, database: proposal.database, task: proposal.task, request: nativeRequest(proposal) });
  }
  return Object.freeze({ freeze, consume, inspect: proposals.get,
    cancel(task) { const anchor = parseTask(task); proposals.cancel(anchor); usage.cancel(anchor); permissionGate.cancel(anchor); },
    prune() { proposals.prune(); usage.prune(); permissionGate.prune(); },
    stats() { return immutable({ proposals: proposals.stats(), usage: usage.stats(), permissions: permissionGate.stats() }); },
    dispose() { proposals.dispose(); usage.dispose(); permissionGate.dispose(); } });
}
