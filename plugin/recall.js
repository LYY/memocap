import { recordActivity } from "./activity.js";
import { run } from "./bridge.js";
import { budgetChars, failure, queryTerms, referenceBlock, repoArgs, textPart,
  validateMemories, validateReceipt } from "./protocol.js";

function realText(parts) {
  return parts.filter((part) => part.type === "text" && !part.synthetic && !part.ignored && !part.metadata?.memocap)
    .map((part) => part.text).join("\n");
}

function ownReference(part) {
  return part.synthetic === true && part.metadata?.memocap?.owner === "memocap" &&
    part.metadata.memocap.trust === "untrusted_reference";
}

export function createRecallRuntime(input, options = {}, invoke = run) {
  const sessions = new Map();
  const warnings = [];
  let ready = false;
  let disposed = false;

  function clear(sessionID) {
    sessions.get(sessionID)?.controller.abort();
    sessions.delete(sessionID);
  }

  function stateFor(sessionID, directory) {
    let state = sessions.get(sessionID);
    if (!state) {
      state = { sessionID, directory, targets: directory ? [directory] : undefined,
        controller: new AbortController(), generation: 0, warnings: [] };
    }
    sessions.delete(sessionID);
    sessions.set(sessionID, state);
    if (sessions.size > 128) clear(sessions.keys().next().value);
    return state;
  }

  function invalidate(state) {
    state.controller.abort();
    state.controller = new AbortController();
    state.generation++;
    state.cache = undefined;
    state.last = undefined;
  }

  async function context(sessionID) {
    const state = stateFor(sessionID);
    if (!state.directory) {
      const session = await input.client.session.get({ path: { id: sessionID } });
      if (!session.data?.directory) throw Object.assign(new Error("Session directory unavailable"), { code: "invalid_request" });
      state.directory = session.data.directory;
      state.targets = [state.directory];
    }
    return state;
  }

  async function request(state, argv, requestOptions = {}) {
    const separator = argv.indexOf("--");
    const caller = requestOptions.caller ?? { sessionID: state.sessionID, messageID: state.messageID };
    const globals = ["--caller-json", JSON.stringify({ actor: "plugin", session_id: caller.sessionID ?? null,
      message_id: caller.messageID ?? null }), "--json"];
    const jsonArgs = separator < 0 ? [...argv, ...globals] : [...argv.slice(0, separator), ...globals, ...argv.slice(separator)];
    const response = await invoke(jsonArgs, {
      cwd: state.directory, signal: requestOptions.signal ?? state.controller.signal,
      deadlineMs: requestOptions.deadlineMs ?? 3000,
    });
    return validateReceipt(response.receipt);
  }

  async function notify(state, status) {
    if (!input.client.tui?.showToast) return;
    try {
      await input.client.tui.showToast({ body: { title: "memocap", variant: status === "failed" ? "warning" : "info",
        message: `${ready ? "Recall" : "Ready; recall"}: ${status}. /memory why`, duration: 3000 } });
      ready = true;
    } catch {
      state.warnings.push({ code: "notification_unavailable" });
    }
  }

  async function recall(state, terms, targets = state.targets, requestOptions = {}) {
    if (terms.length === 0) return undefined;
    const receipt = await request(state, ["recall", terms.join(" "), "--match", "any", "--limit", "3",
      "--max-chars", String(budgetChars), ...repoArgs(targets)], requestOptions);
    return validateMemories(receipt);
  }

  async function automatic(state) {
    const key = JSON.stringify([state.messageID, state.targets, state.terms, "any-v1"]);
    const cacheHit = state.cache?.key === key;
    if (!cacheHit) {
      const expiresAt = Date.now() + 3000;
      const pending = recall(state, state.terms).then((receipt) => ({ receipt, expiresAt }),
        (error) => ({ failure: failure(error), expiresAt }));
      state.cache = { key, pending };
    }
    return { ...await state.cache.pending, cacheHit };
  }

  async function inject(message, state, recalled) {
    const generation = state.generation;
    const receipt = recalled.receipt;
    const metadata = { owner: "memocap", trust: "untrusted_reference", session_id: state.sessionID,
      message_id: state.messageID, targets: state.targets, query_terms: state.terms,
      strategy: "any-v1", cache_hit: recalled.cacheHit, status: receipt?.status ?? recalled.failure?.status ?? "skipped",
      operation_id: receipt?.operation_id, returned_ids: receipt?.returned_ids ?? [],
      error: recalled.failure?.error, warnings: [...(receipt?.warning ? [receipt.warning] : []), ...state.warnings, ...warnings] };
    const block = referenceBlock(receipt, metadata);
    Object.assign(metadata, { injected_ids: block.injected_ids, injected_chars: block.text.length,
      injection_status: receipt ? (block.injected_ids.length ? "prepared" : "empty") : metadata.status });
    const warning = await recordActivity({ state, receipt, metadata, request,
      expiresAt: recalled.cacheHit ? Date.now() + 3000 : recalled.expiresAt });
    if (warning) metadata.warnings.push(warning);
    if (disposed || generation !== state.generation || sessions.get(state.sessionID) !== state) return;
    state.last = metadata;
    const part = textPart(state, block.text, metadata);
    message.parts = message.parts.filter((existing) => !ownReference(existing));
    message.parts.push(part);
    if (!recalled.cacheHit) await notify(state, metadata.status);
  }

  async function capture(hookInput, output) {
    const text = realText(output.parts);
    if (output.message.role !== "user" || !text.trim()) return;
    const state = stateFor(output.message.sessionID ?? hookInput.sessionID);
    if (state.messageID !== output.message.id) invalidate(state);
    state.messageID = output.message.id;
    state.terms = queryTerms(text);
  }

  async function transform(_hookInput, output) {
    if (disposed) return;
    for (const message of output.messages) {
      message.parts = message.parts.filter((part) => !ownReference(part));
    }
    const message = output.messages.findLast((entry) => entry.info.role === "user" && realText(entry.parts).trim());
    if (!message) return;
    let state;
    try {
      state = await context(message.info.sessionID);
      if (state.messageID !== message.info.id) await capture({ sessionID: message.info.sessionID },
        { message: message.info, parts: message.parts });
      if (options.automatic === false && !state.cache) return;
      const generation = state.generation;
      const recalled = await automatic(state);
      if (disposed || generation !== state.generation || !sessions.has(state.sessionID)) return;
      await inject(message, state, recalled);
    } catch (error) {
      state ??= stateFor(message.info.sessionID);
      state.messageID = message.info.id;
      const metadata = { owner: "memocap", trust: "untrusted_reference", ...failure(error), injection_status: "failed" };
      state.last = metadata;
      const part = textPart(state, JSON.stringify(metadata), metadata);
      message.parts = message.parts.filter((existing) => !ownReference(existing));
      message.parts.push(part);
      await notify(state, "failed");
    }
  }

  function seed(state, terms, receipt) {
    state.terms = terms;
    const key = JSON.stringify([state.messageID, state.targets, terms, "any-v1"]);
    state.cache = { key, pending: Promise.resolve({ receipt, expiresAt: Date.now() + 3000 }) };
  }

  return { context, request, recall, invalidate, stateFor, capture, transform, seed, warnings,
    report: async (status) => notify({ warnings }, status),
    get size() { return sessions.size; },
    async compact({ sessionID }) { clear(sessionID); },
    async event({ event }) {
      if (event.type === "session.deleted") clear(event.properties.info.id);
      if (event.type === "session.error" && event.properties.sessionID) clear(event.properties.sessionID);
    },
    async dispose() { disposed = true; for (const sessionID of sessions.keys()) clear(sessionID); },
  };
}
