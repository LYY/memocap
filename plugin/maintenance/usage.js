import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { exactObject, hash, immutable, parseCaller, parseDatabase, parseDigest, parseID, parseName, parsePlacement,
  parseSnapshot, parseTask, parseText, requireMaintenance, sameTask, taskOf } from "./boundary.js";
import { createBoundedRegistry } from "./registry.js";
import { uniqueQuoteSpan } from "./quote.js";

export function createUsageRegistry(options) {
  const records = createBoundedRegistry(options);
  const continued = createBoundedRegistry(options);
  const observed = new WeakSet();
  const prepared = new WeakSet();
  function registerFullRead(input, nativeCaller) {
    const read = exactObject(input, ["operation", "status", "completeness", "database", "snapshot", "content_hash"]);
    requireMaintenance(read.operation === "read" && read.status === "ok" && read.completeness === "full", "invalid_request");
    parseDatabase(read.database); parseDigest(read.content_hash); parseSnapshot(read.snapshot);
    const caller = parseCaller(nativeCaller);
    requireMaintenance(hash(read.snapshot.content) === read.content_hash, "body_hash_mismatch");
    const receipt_id = randomUUID();
    records.put({ ...read, task: taskOf(caller), caller, receipt_id, used: null }, receipt_id);
    return immutable({ receipt_id, id: read.snapshot.id, placement: read.snapshot.placement, content_hash: read.content_hash });
  }
  function declareUse(input, nativeCaller, currentSnapshot) {
    const declaration = exactObject(input, ["receipt_id", "id", "placement", "content_hash", "statements"]);
    parseName(declaration.receipt_id); parseID(declaration.id); parsePlacement(declaration.placement); parseDigest(declaration.content_hash);
    requireMaintenance(Array.isArray(declaration.statements) && declaration.statements.length > 0 && declaration.statements.length <= 8, "invalid_request");
    declaration.statements.forEach((quote) => { parseText(quote); requireMaintenance(quote.trim().length > 0, "invalid_request"); });
    const caller = parseCaller(nativeCaller);
    const current = parseSnapshot(currentSnapshot);
    const receipt = records.get(declaration.receipt_id);
    requireMaintenance(sameTask(receipt.task, caller), "task_mismatch");
    requireMaintenance(receipt.used === null, "already_used");
    requireMaintenance(declaration.id === receipt.snapshot.id && declaration.placement === receipt.snapshot.placement &&
      declaration.content_hash === receipt.content_hash, "reference_mismatch");
    requireMaintenance(isDeepStrictEqual(receipt.snapshot, current), "snapshot_changed");
    const spans = declaration.statements.map((quote) => {
      const span = uniqueQuoteSpan(current.content, quote);
      requireMaintenance(span, "adoption_not_unique");
      return span;
    });
    requireMaintenance(new Set(declaration.statements).size === spans.length &&
      spans.reduce((sum, span) => sum + span.end - span.start, 0) <= 800, "input_budget");
    const used = { use_id: randomUUID(), receipt_id: receipt.receipt_id, database: receipt.database,
      task: receipt.task, caller, snapshot: receipt.snapshot, content_hash: receipt.content_hash, spans };
    records.put({ ...receipt, used }, receipt.receipt_id);
    const result = immutable(structuredClone(used));
    observed.add(result);
    return result;
  }
  function getUse(useID, task) {
    const anchor = parseTask(task);
    parseName(useID);
    const receipt = records.values().find((entry) => entry.used?.use_id === useID);
    if (!receipt) {
      const use = continued.get(useID);
      requireMaintenance(sameTask(use.task, anchor), "task_mismatch");
      return use;
    }
    records.get(receipt.receipt_id);
    requireMaintenance(sameTask(receipt.task, anchor), "task_mismatch");
    return receipt.used;
  }
  return Object.freeze({ registerFullRead, declareUse, getUse,
    prepareContinuation(prior, task, continuation) {
      requireMaintenance(observed.has(prior), "reference_unavailable");
      const use = immutable({ ...prior, use_id: randomUUID(), task: parseTask(task),
        adoption: prior.adoption ?? { task: prior.task, caller: prior.caller, use_id: prior.use_id, receipt_id: prior.receipt_id }, continuation });
      prepared.add(use);
      return use;
    },
    acceptContinuation(use) {
      requireMaintenance(prepared.has(use), "continuity_unknown");
      prepared.delete(use); observed.add(use); continued.put(use, use.use_id);
    },
    cancel(task) { const anchor = parseTask(task); records.cancel(anchor); continued.cancel(anchor); },
    prune() { records.prune(); continued.prune(); }, stats: records.stats,
    dispose() { records.dispose(); continued.dispose(); } });
}
