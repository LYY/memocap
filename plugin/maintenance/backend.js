import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { run } from "../bridge.js";
import { freezeOrganization } from "../organization-backend.js";
import { approvedPostconditions, keyToken, validateOrganizationReceipt } from "../organization-contract.js";
import { validateReceipt } from "../protocol.js";
import { parseSnapshot, requireMaintenance } from "./boundary.js";

export function createMaintenanceBackend(runtime, invoke = run) {
  const freeze = (context) => {
    const frozen = freezeOrganization({ operation: "page", request: "{}" }, context, runtime.configuredCwd);
    const database = realpathSync(frozen.database);
    return Object.freeze({ ...frozen, database, env: Object.freeze({ ...frozen.env, MEMOCAP_DB: database }) });
  };
  async function read(keys, context, frozen = freeze(context)) {
    requireMaintenance(keys.length > 0 && keys.length <= 3, "input_budget");
    const request = { keys: keys.map(({ id, placement }) => ({ id, placement })) };
    const native = { ...frozen, operation: "read", request };
    const response = await invoke(["organize", "read", ...frozen.argv.slice(2)], { cwd: frozen.cwd, env: frozen.env,
      stdin: JSON.stringify(request), signal: context.abort, deadlineMs: 3000 });
    return { database: frozen.database, records: validateOrganizationReceipt(response.receipt, native).organization.records };
  }
  async function commit(proposal, dispatch) {
    const { context, request, beforeSpawn } = dispatch;
    const frozen = freeze(context);
    requireMaintenance(frozen.database === proposal.database, "database_changed");
    const stdin = JSON.stringify(request);
    requireMaintenance(Buffer.byteLength(stdin) <= 65536, "input_budget");
    let receipt;
    let dispatched = false;
    let failure;
    try {
      const response = await invoke(["organize", "maintain", ...frozen.argv.slice(2)], {
        cwd: frozen.cwd, env: frozen.env, stdin, signal: AbortSignal.timeout(3000), deadlineMs: 3000,
        beforeSpawn() { beforeSpawn(frozen); dispatched = true; },
      });
      receipt = response.receipt;
      validateReceipt(receipt);
      requireMaintenance(receipt.operation === "organize_maintain" && receipt.backend === "local" &&
        receipt.caller?.actor === "plugin" && receipt.caller.session_id === context.sessionID && receipt.caller.message_id === context.messageID &&
        receipt.status === "ok" && receipt.outcome === "committed" && receipt.targets.length === 0 && receipt.results.length === 0 &&
        ["recorded", "failed"].includes(receipt.activity_status) && receipt.organization?.database === proposal.database, "invalid_receipt");
      const post = receipt.organization;
      requireMaintenance(Array.isArray(post.records) && Array.isArray(post.deleted), "invalid_receipt");
      post.records.forEach(parseSnapshot);
      requireMaintenance(approvedPostconditions(request, post) && isDeepStrictEqual(receipt.returned_ids, post.records.map((record) => record.id)), "invalid_receipt");
    } catch (error) {
      failure = error;
      receipt ??= error.receipt;
      if (!dispatched) return { status: "blocked", outcome: "not_started", error: { code: error.code ?? "dispatch_failed" }, no_replay: true };
      let rollback = false;
      try { validateReceipt(receipt); }
      catch (validation) { rollback = validation.code === "cli_failed" && validation.receipt === receipt; }
      if (rollback && receipt.operation === "organize_maintain" && receipt.backend === "local" &&
        receipt.caller?.actor === "plugin" && receipt.caller.session_id === context.sessionID && receipt.caller.message_id === context.messageID &&
        receipt.targets.length === 0 && receipt.results.length === 0 && receipt.returned_ids.length === 0 &&
        receipt.outcome === "rolled_back" && ["rejected", "failed"].includes(receipt.status)) {
        return { status: "conflict", outcome: "rolled_back", error: { code: receipt.error?.code ?? "database_error" }, no_replay: true };
      }
    }
    const keys = proposal.used.map((entry) => entry.snapshot);
    let readback;
    try {
      readback = await read(keys, { ...context, abort: AbortSignal.timeout(3000) }, frozen);
      if (!failure) {
        const expected = new Map([...receipt.organization.records.map((record) => [keyToken(record), record]),
          ...receipt.organization.deleted.map((record) => [keyToken(record), null]),
          ...request.dependencies.map((record) => [keyToken(record), record])]);
        requireMaintenance(readback.records.every((entry) => expected.has(keyToken(entry)) &&
          isDeepStrictEqual(entry.snapshot, expected.get(keyToken(entry)))), "readback_mismatch");
      }
    } catch (error) { failure ??= error; }
    return { status: failure ? "unknown" : "committed", outcome: failure ? "outcome_unknown" : "committed", no_replay: true,
      ...(!failure && receipt.activity_status === "failed" ? { warning: "maintenance_activity_failed" } : {}),
      operation_id: receipt?.operation_id, ...(failure ? { error: { code: failure.code ?? "readback_failed" } } : {}),
      untrusted_data: { receipt: receipt ?? null, readback: readback ?? null } };
  }
  return { freeze, read, commit };
}
