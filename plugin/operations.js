import path from "node:path";
import { discoveryFor, exactPlacement } from "./discovery.js";
import { failure, packageVersion, queryTerms, repoArgs, validateRead } from "./protocol.js";
import { invalidRequest, repositoryID } from "./targets.js";

function localPaths(paths, directory) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8 ||
      paths.some((entry) => typeof entry !== "string" || !entry.trim() || entry.includes("\0"))) invalidRequest();
  const resolved = [...new Set(paths.map((entry) => path.resolve(directory, entry)))];
  if (resolved.some((entry) => /[*?]/.test(entry))) invalidRequest();
  return resolved;
}

export function createOperations(runtime, rememberHooks = {}) {
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
    state.agent = context.agent ?? state.agent;
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
    const discovery = discoveryFor(args, state.discovery);
    state.permissionKey = await runtime.readPermission.authorize({ ...context, agent: state.agent }, { operation: "scope", targets: proposed, discovery });
    if (context.approvedTargets) approved(context, state);
    if (signal.aborted) invalidRequest();
    const receipt = await runtime.recall(state, terms, proposed, { signal, caller: context, discovery });
    if (!receipt || generation !== state.generation || signal.aborted) invalidRequest();
    runtime.invalidate(state);
    state.targets = proposed;
    state.discovery = discovery;
    runtime.seed(state, terms, receipt);
    return receipt;
  }

  async function recall(args, context) {
    if (typeof args.query !== "string" || queryTerms(args.query).length === 0) invalidRequest();
    const state = await current(context);
    const signal = signalFor(state, context);
    const terms = queryTerms(args.query);
    const selected = context.approvedTargets ? approved(context, state) : await runtime.selected(state);
    const discovery = discoveryFor(args, state.discovery);
    state.permissionKey = await runtime.readPermission.authorize({ ...context, agent: state.agent }, { operation: "recall", targets: selected, discovery });
    if (context.approvedTargets) approved(context, state);
    if (signal.aborted) invalidRequest();
    const receipt = await runtime.recall(state, terms, selected, { signal, caller: context, discovery });
    if (signal.aborted) invalidRequest();
    runtime.invalidateCache(state);
    state.discovery = discovery;
    runtime.seed(state, terms, receipt);
    return receipt;
  }

  async function readback(state, saved, context) {
    try {
      const checked = validateRead(await runtime.request(state,
        ["read", String(saved.id), "--placement", saved.placement, ...repoArgs(context.approvedTargets)],
        { signal: AbortSignal.timeout(3000), caller: context }), saved);
      if (checked.results[0].memory.content !== saved.content) return { ...checked, status: "failed", error: { code: "readback_mismatch" } };
      return checked;
    } catch (error) { return failure(error); }
  }

  async function read(args, context) {
    if (!Number.isSafeInteger(args.id) || args.id <= 0 || !exactPlacement(args.placement) ||
        (args.content_hash !== undefined && !/^[a-f0-9]{64}$/.test(args.content_hash))) invalidRequest();
    const state = await current(context);
    const signal = signalFor(state, context);
    const selected = context.approvedTargets ? approved(context, state) : await runtime.selected(state);
    await runtime.readPermission.authorize({ ...context, agent: state.agent }, { operation: "read", targets: selected,
      discovery: { kind: "origins", placements: [args.placement] }, id: args.id, placement: args.placement }, true);
    if (context.approvedTargets) approved(context, state);
    if (signal.aborted) invalidRequest();
    return validateRead(await runtime.request(state, ["read", String(args.id), "--placement", args.placement, ...repoArgs(selected)],
      { signal, caller: context }), args);
  }

  async function remember(args, context) {
    if (typeof args.content !== "string" || !args.content.trim() || args.content.includes("\0") ||
        (args.domain && args.universal)) invalidRequest();
    const state = await current(context);
    const selected = context.approvedTargets ? approved(context, state) : await targets(context, args);
    const generation = state.generation;
    if (selected.length !== 1) invalidRequest();
    const placement = args.universal ? "universal" : args.domain ? `domain:${args.domain}` : selected[0].repository_id;
    const argv = ["remember", "--type", args.type ?? "context", "--tags", (args.tags ?? []).join(",")];
    if (args.topic) argv.push("--topic", args.topic);
    if (args.domain) argv.push("--domain", args.domain);
    if (args.universal) argv.push("--universal");
    argv.push(...repoArgs(selected), "--", args.content);
    await rememberHooks.beforeCommit?.(args, context, selected);
    if (context.approvedTargets) approved(context, state);
    if (signalFor(state, context).aborted) invalidRequest();
    const receipt = await runtime.request(state, argv, { signal: AbortSignal.timeout(3000), caller: context,
      beforeSpawn() {
        if (generation !== state.generation || signalFor(state, context).aborted) invalidRequest();
        context.beforeSpawn?.();
      } });
    if (!["inserted", "updated"].includes(receipt.status) || receipt.returned_ids.length !== 1 ||
        receipt.searched_placements?.length !== 1) invalidRequest();
    runtime.invalidateCache(state);
    const checked = await readback(state, { id: receipt.returned_ids[0], placement, content: args.content.trim() },
      { ...context, approvedTargets: selected });
    return { ...receipt, readback: checked,
      warnings: [...(receipt.warnings ?? []), ...(checked.status === "ok" ? [] : [{ code: "readback_failed" }])] };
  }

  async function freezeCapture(context, { target, content, type = "context", tags = [], topic, guard, beforeSpawn }) {
    if (!target || !repositoryID.test(target.repository_id) || !exactPlacement(target.placement) ||
        (target.placement.startsWith("repository:") && target.placement !== target.repository_id) ||
        typeof content !== "string" || !content.trim() || content.includes("\0")) invalidRequest();
    const { repository_id: repository, placement } = target;
    const args = Object.freeze({ content: content.trim(), type, tags: Object.freeze([...tags]), topic,
      ...(placement === "universal" ? { universal: true } :
        placement.startsWith("domain:") ? { domain: placement.slice(7) } : {}) });
    const selected = await targets(context);
    if (selected.length !== 1 || selected[0].repository_id !== repository) invalidRequest();
    const frozenContext = { ...context, approvedTargets: selected, beforeSpawn };
    let consumed = false;
    return Object.freeze({ args, targets: selected, async execute() {
      if (consumed) invalidRequest();
      consumed = true;
      await guard?.("before_ask");
      approved(frozenContext, await current(frozenContext));
      await rememberHooks.beforeAsk?.(args, frozenContext, selected);
      await frozenContext.ask({ permission: "memocap_remember", patterns: [repository], always: [repository],
        metadata: { operation: "remember", targets: selected, placement } });
      await guard?.("before_commit");
      return remember(args, frozenContext);
    } });
  }

  async function inspect(command, argument, context) {
    const state = await current(context);
    if (command === "status") {
      const receipts = [];
      for (const target of await runtime.selected(state)) receipts.push(await request(state, ["status", "--read-only", ...repoArgs([target])], context));
      return { status: "ok", plugin_version: packageVersion, targets: state.targets, receipts,
        current: state.last ?? { status: "not_run" }, capture: runtime.captureStatus?.(state.sessionID), warnings: runtime.warnings };
    }
    if (command === "scopes") return request(state, ["scope", "list", "--all"], context);
    if (command === "recent") return request(state, ["activity", "list", "--writes", "--limit", "20", "--session", state.sessionID], context);
    if (command === "why") {
      const operationID = state.last?.activity_operation_id ?? state.last?.operation_id;
      const capture = runtime.captureStatus?.(state.sessionID);
      if (!operationID) return { status: "not_run", current: state.last ?? { status: "not_run" }, capture };
      return { ...await request(state, ["activity", "show", operationID], context), current: state.last, capture };
    }
    if (command === "list") {
      const [placement, offset = "0"] = argument;
      if (!/^(repository:|domain:|universal$)/.test(placement ?? "") || !/^\d+$/.test(offset)) invalidRequest();
      await runtime.readPermission.check({ ...context, agent: state.agent });
      return request(state, ["list", "--placement", placement, "--limit", "20", "--offset", offset,
        ...repoArgs([...(await runtime.selected(state))].slice(0, 1))], context);
    }
    invalidRequest();
  }

  return { targets, scope, recall, read, remember, inspect, freezeCapture,
    async beforeRememberAsk(args, context, selected) { await rememberHooks.beforeAsk?.(args, context, selected); } };
}
