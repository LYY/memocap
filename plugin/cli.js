import { createCapture } from "./capture/index.js";
import { createCommands } from "./commands.js";
import { createOperations } from "./operations.js";
import { createOrganization } from "./organization.js";
import { loadPolicy } from "./policy.js";
import { createRecallRuntime } from "./recall.js";
import { createTools } from "./tools.js";

export async function memocap(input, options = {}) {
  const policy = loadPolicy(options);
  const runtime = createRecallRuntime(input, options);
  const operations = { ...createOperations(runtime), organization: createOrganization(runtime, policy) };
  const commands = createCommands(operations, runtime, policy.provenance);
  const capture = createCapture(input, runtime, operations);
  return {
    tool: createTools(operations, capture), config: async (config) => { runtime.config(config); await commands.config(config); },
    "chat.params": capture.params,
    "tool.execute.before": capture.before,
    "tool.execute.after": async (input, output) => {
      if (!["memocap_organize", "memocap_scope", "memocap_recall", "memocap_read", "memocap_remember"].includes(input.tool) ||
          typeof output.metadata?.memocap_complete_output !== "string") return;
      output.output = output.metadata.memocap_complete_output;
      output.metadata.truncated = false;
      delete output.metadata.memocap_complete_output;
      delete output.metadata.outputPath;
    },
    "command.execute.before": commands.execute,
    "chat.message": async (hookInput, output) => {
      capture.observe(hookInput, output);
      if (!capture.owns(hookInput.sessionID)) await runtime.capture(hookInput, output);
    },
    "experimental.chat.messages.transform": async (hookInput, output) => {
      if (output.messages.some((message) => capture.owns(message.info.sessionID))) return;
      await runtime.transform(hookInput, output);
    },
    "experimental.session.compacting": async (hookInput, output) => {
      await runtime.compact(hookInput);
      output.context.push(policy.rules);
    },
    event: (event) => { capture.event(event); return runtime.event(event); },
    dispose: async () => { await capture.dispose(); await runtime.dispose(); },
  };
}
