import { createCommands } from "./commands.js";
import { createOperations } from "./operations.js";
import { loadPolicy } from "./policy.js";
import { createRecallRuntime } from "./recall.js";
import { createTools } from "./tools.js";

export async function memocap(input, options = {}) {
  const policy = loadPolicy(options);
  const runtime = createRecallRuntime(input, options);
  const operations = createOperations(runtime);
  const commands = createCommands(operations, runtime, policy.provenance);
  return {
    tool: createTools(operations), config: commands.config,
    "command.execute.before": commands.execute, "chat.message": runtime.capture,
    "experimental.chat.messages.transform": runtime.transform,
    "experimental.session.compacting": async (hookInput, output) => {
      await runtime.compact(hookInput);
      output.context.push(policy.rules);
    },
    event: runtime.event, dispose: runtime.dispose,
  };
}
