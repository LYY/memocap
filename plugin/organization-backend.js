import os from "node:os";
import path from "node:path";
import { organizationError, parseOrganizationRequest } from "./organization-contract.js";

export function freezeOrganization(args, context, configuredCwd = process.cwd()) {
  const env = { ...process.env };
  const address = [env.MEMOCAP_ADDR, env.MEMOCAP_URL, env.MEMOCAP_ADDRESS]
    .map((entry) => entry?.trim()).find(Boolean);
  if (address) throw organizationError("unsupported_backend", "Memory organization supports only the configured local database.");
  const home = env.MEMOCAP_HOME || (process.platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
  const database = path.resolve(configuredCwd, env.MEMOCAP_DB || path.join(env.MEMOCAP_DATA_DIR || path.join(home, ".memocap"), "memocap.db"));
  if (database.includes("\0") || /[*?]/.test(database)) throw organizationError("invalid_request", "Database path cannot be a permission wildcard.");
  const request = parseOrganizationRequest(args.operation, args.request);
  if ((args.operation !== "page" || request.after_id != null || request.upper_id != null) && !args.database) {
    throw organizationError("backend_required", "Use the database identity from the preview for this request.");
  }
  if (args.database !== undefined && args.database !== database) {
    throw organizationError("backend_changed", "Configured database differs from the preview; start a new preview.");
  }
  if (args.operation === "apply" && args.confirmed !== true) {
    throw organizationError("confirmation_required", "Present the concrete proposal and obtain user confirmation before apply.");
  }
  env.MEMOCAP_DB = database;
  const caller = { actor: "plugin", session_id: context.sessionID ?? null, message_id: context.messageID ?? null };
  return Object.freeze({ operation: args.operation, database, request, stdin: JSON.stringify(request), cwd: path.parse(configuredCwd).root,
    env: Object.freeze(env), argv: Object.freeze(["organize", args.operation, "--json", "--caller-json", JSON.stringify(caller)]),
    signal: context.abort, mode: args.operation === "apply" ? request.mode : args.operation === "page" ? request.selection ?? "pending" : "exact" });
}

export function organizationPermission(frozen) {
  return { permission: "memocap_organize", patterns: [frozen.database], always: [frozen.database],
    metadata: { operation: frozen.operation, mode: frozen.mode, database: frozen.database,
      request: JSON.parse(frozen.stdin), stdin: frozen.stdin, argv: [...frozen.argv], cwd: frozen.cwd } };
}
