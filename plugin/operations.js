import path from "node:path";
import { failure, packageVersion, queryTerms, repoArgs, validateInventory } from "./protocol.js";
import { invalidRequest, repositoryID } from "./targets.js";

function localPaths(paths, directory) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8 ||
      paths.some((entry) => typeof entry !== "string" || !entry.trim() || entry.includes("\0"))) invalidRequest();
  const resolved = [...new Set(paths.map((entry) => path.resolve(directory, entry)))];
  if (resolved.some((entry) => /[*?]/.test(entry))) invalidRequest();
  return resolved;
}

export function createOperations(runtime) {
  const approvals = new WeakMap();
  async function targets(context, args = {}) {
    const state = await current(context);
    const generation = state.generation;
    const signal = signalFor(state, context);
    if (args.paths !== undefined && args.repository_ids !== undefined) invalidRequest();
    let selected;
    if (args.repository_ids !== undefined) {
      const ids = args.repository_ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length ||
          ids.some((id) => typeof id !== "string" || !repositoryID.test(id))) invalidRequest();
      selected = await runtime.resolve(state, ids.flatMap((id) => ["--repository-id", id]), { signal, caller: context });
    } else if (args.paths !== undefined || args.repository !== undefined) {
      const paths = localPaths(args.paths ?? [args.repository], state.directory);
      selected = await runtime.resolve(state, paths.flatMap((directory) => ["--repo", directory]), { signal, caller: context });
    } else selected = await runtime.selected(state, { signal, caller: context });
    if (generation !== state.generation || signal.aborted) invalidRequest();
    approvals.set(selected, { state, generation, signal });
    return selected;
  }

  function approved(context, state) {
    const selected = context.approvedTargets;
    const approval = approvals.get(selected);
    if (!approval || approval.state !== state || approval.generation !== state.generation || approval.signal.aborted) invalidRequest();
    return selected;
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
    if (args.paths === undefined && args.repository_ids === undefined) invalidRequest();
    const proposed = context.approvedTargets ? approved(context, state) : await targets(context, args);
    const generation = state.generation;
    const signal = signalFor(state, context);
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
    const receipt = await runtime.recall(state, terms, context.approvedTargets ? approved(context, state) : await runtime.selected(state), { signal, caller: context });
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
          ["list", "--placement", placement, "--limit", "20", "--offset", String(offset), ...repoArgs(context.approvedTargets)], context));
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
    const selected = context.approvedTargets ? approved(context, state) : await targets(context, args);
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
      for (const target of await runtime.selected(state)) receipts.push(await request(state, ["status", "--read-only", ...repoArgs([target])], context));
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
        ...repoArgs([...(await runtime.selected(state))].slice(0, 1))], context);
    }
    invalidRequest();
  }

  return { targets, scope, recall, remember, inspect };
}
