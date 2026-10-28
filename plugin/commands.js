import { memoryHelp, organizationCommand } from "./memory-help.js";
import { failure, textPart } from "./protocol.js";

function pathArguments(raw) {
  const paths = [];
  let token = "";
  let quote;
  for (const character of raw) {
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) { if (token) { paths.push(token); token = ""; } }
    else token += character;
  }
  if (quote) throw Object.assign(new Error("Unclosed path quote"), { code: "invalid_request" });
  if (token) paths.push(token);
  return paths;
}

export function createCommands(operations, runtime, policy) {
  let registered = false;
  const definition = { description: "Memory help, organize, status, scopes, list, recent, why; scope, recall, or request remember.",
    template: "memocap /memory request; command hook supplies the actual structured receipt." };

  async function dispatch(command, raw, context) {
    if (command === "help") return memoryHelp("help", raw.trim().length > 0);
    if (command === "organize") {
      const parsed = organizationCommand(raw);
      return parsed.help ?? operations.organization.preview(parsed.selection, context);
    }
    if (command === "remember") return { status: "not_run", tool: "memocap_remember", arguments: { content: raw },
      reason: "permission_aware_tool_required" };
    if (command === "scope") return operations.scope({ paths: pathArguments(raw) }, context);
    if (command === "recall") return operations.recall({ query: raw }, context);
    const payload = await operations.inspect(command || "status", pathArguments(raw), context);
    return (!command || command === "status") && policy ? { ...payload, policy } : payload;
  }

  return {
    async config(config) {
      config.command ??= {};
      if (config.command.memory && config.command.memory !== definition) {
        runtime.warnings.push({ code: "command_conflict", command: "memory" });
        await runtime.report("command_conflict");
        return;
      }
      config.command.memory = definition;
      registered = true;
    },
    async execute(input, output) {
      if (input.command !== "memory" || !registered) return;
      const parsed = /^\s*(\S+)?(?:\s([\s\S]*))?$/.exec(input.arguments);
      let payload;
      try {
        if (!parsed) throw Object.assign(new Error("Invalid command"), { code: "invalid_request" });
        payload = await dispatch(parsed[1] ?? "status", parsed[2] ?? "", { sessionID: input.sessionID,
          messageID: output.parts.find((part) => part.messageID)?.messageID });
      } catch (error) { payload = failure(error); }
      const state = runtime.stateFor(input.sessionID);
      const quiet = ["organize", "help"].includes(parsed?.[1]);
      if (quiet) runtime.invalidate(state);
      state.messageID = output.parts.find((part) => part.messageID)?.messageID ?? state.messageID;
      output.parts.splice(0, output.parts.length,
        textPart(state, JSON.stringify(payload), { owner: "memocap_command", status: payload.status,
          ...(quiet ? { command: parsed[1], suppress_auto_recall: true } : {}) }));
    },
  };
}
