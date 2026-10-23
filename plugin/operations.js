import path from "node:path";
import { failure, packageVersion, queryTerms, repoArgs, validateInventory } from "./protocol.js";

function invalidRequest() {
  throw Object.assign(new Error("Invalid memory request"), { code: "invalid_request" });
}

function localPaths(paths, directory) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8 ||
      paths.some((entry) => typeof entry !== "string" || !entry.trim() || entry.includes("\0"))) invalidRequest();
  const resolved = [...new Set(paths.map((entry) => path.resolve(directory, entry)))];
  if (resolved.some((entry) => /[*?]/.test(entry))) invalidRequest();
  return resolved;
}

export function createOperations(runtime) {
  async function targets(context, args = {}) {
    const state = await current(context);
    return Object.freeze(localPaths(args.paths ?? (args.repository ? [args.repository] : state.targets), state.directory));
  }

  async function current(context) {
    const state = await runtime.context(context.sessionID, context.directory);
    state.messageID ??= context.messageID;
    return state;
  }

  function signalFor(state, context) {
    return context.abort ? AbortSignal.any([context.abort, state.controller.signal]) : state.controller.signal;
  }

  function request(state, argv, context) {
    return runtime.request(state, argv, { signal: signalFor(state, context), caller: context });
  }

  async function scope(args, context) {
    const state = await current(context);
    const proposed = context.approvedTargets ?? localPaths(args.paths, state.directory);
    const generation = state.generation;
    const signal = signalFor(state, context);
    for (const directory of proposed) {
      const receipt = await request(state, ["scope", "show", "--repo", directory], context);
      if (receipt.targets.length !== 1 || !receipt.targets[0].canonical_path) invalidRequest();
    }
    const terms = args.query ? queryTerms(args.query) : state.terms ?? ["memory"];
    const receipt = await runtime.recall(state, terms, proposed, { signal, caller: context });
    if (!receipt || generation !== state.generation || signal.aborted) invalidRequest();
    runtime.invalidate(state);
    state.targets = proposed;
    runtime.seed(state, terms, receipt);
    return receipt;
  }

  async function recall(args, context) {
    if (typeof args.query !== "string" || queryTerms(args.query).length === 0) invalidRequest();
    const state = await current(context);
    const signal = signalFor(state, context);
    const terms = queryTerms(args.query);
    const receipt = await runtime.recall(state, terms, context.approvedTargets ?? state.targets, { signal, caller: context });
    if (signal.aborted) invalidRequest();
    runtime.invalidate(state);
    runtime.seed(state, terms, receipt);
    return receipt;
  }

  async function readback(state, receipt, context) {
    try {
      const placement = receipt.searched_placements[0];
      for (let offset = 0; ; offset += 20) {
        const checked = validateInventory(await request(state,
          ["list", "--placement", placement, "--limit", "20", "--offset", String(offset), "--repo", context.approvedTargets[0]], context));
        const found = receipt.returned_ids.every((id) => checked.returned_ids.includes(id));
        if (found || checked.results.length < 20) return { status: found ? "ok" : "failed",
          operation_id: checked.operation_id, returned_ids: checked.returned_ids };
      }
    } catch (error) { return failure(error); }
  }

  async function remember(args, context) {
    if (typeof args.content !== "string" || !args.content.trim() || args.content.includes("\0") ||
        (args.domain && args.universal)) invalidRequest();
    const state = await current(context);
    const selected = context.approvedTargets ?? localPaths(args.repository ? [args.repository] : state.targets, state.directory);
    if (selected.length !== 1) invalidRequest();
    const argv = ["remember", "--type", args.type ?? "context", "--tags", (args.tags ?? []).join(",")];
    if (args.topic) argv.push("--topic", args.topic);
    if (args.domain) argv.push("--domain", args.domain);
    if (args.universal) argv.push("--universal");
    argv.push(...repoArgs(selected), "--", args.content);
    const receipt = await request(state, argv, context);
    if (!["inserted", "updated"].includes(receipt.status) || receipt.returned_ids.length !== 1 ||
        receipt.searched_placements?.length !== 1) invalidRequest();
    runtime.invalidate(state);
    const checked = await readback(state, receipt, { ...context, approvedTargets: selected });
    return { ...receipt, readback: checked,
      warnings: [...(receipt.warnings ?? []), ...(checked.status === "ok" ? [] : [{ code: "readback_failed" }])] };
  }

  async function inspect(command, argument, context) {
    const state = await current(context);
    if (command === "status") {
      const receipts = [];
      for (const directory of state.targets) receipts.push(await request(state, ["status", "--read-only", "--repo", directory], context));
      return { status: "ok", plugin_version: packageVersion, targets: state.targets, receipts,
        current: state.last ?? { status: "not_run" }, warnings: runtime.warnings };
    }
    if (command === "scopes") return request(state, ["scope", "list", "--all"], context);
    if (command === "recent") return request(state, ["activity", "list", "--writes", "--limit", "20", "--session", state.sessionID], context);
    if (command === "why") {
      const operationID = state.last?.activity_operation_id ?? state.last?.operation_id;
      if (!operationID) return { status: "not_run", current: state.last ?? { status: "not_run" } };
      return { ...await request(state, ["activity", "show", operationID], context), current: state.last };
    }
    if (command === "list") {
      const [placement, offset = "0"] = argument;
      if (!/^(repository:|domain:|universal$)/.test(placement ?? "") || !/^\d+$/.test(offset)) invalidRequest();
      return request(state, ["list", "--placement", placement, "--limit", "20", "--offset", offset,
        "--repo", state.targets[0]], context);
    }
    invalidRequest();
  }

  return { targets, scope, recall, remember, inspect };
}
