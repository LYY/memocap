import { readFile } from "node:fs/promises";
import { createCommands } from "./commands.js";
import { createOperations } from "./operations.js";
import { createRecallRuntime } from "./recall.js";
import { createTools } from "./tools.js";

const skill = await readFile(new URL("../skills/memocap/SKILL.md", import.meta.url), "utf8");
export const RULES = skill.slice(skill.indexOf("<!-- memocap:begin -->"),
  skill.indexOf("<!-- memocap:end -->") + "<!-- memocap:end -->".length);

export async function memocap(input, options = {}) {
  const runtime = createRecallRuntime(input, options);
  const operations = createOperations(runtime);
  const commands = createCommands(operations, runtime);
  return {
    tool: createTools(operations), config: commands.config,
    "command.execute.before": commands.execute, "chat.message": runtime.capture,
    "experimental.chat.messages.transform": runtime.transform,
    "experimental.session.compacting": async (hookInput, output) => {
      await runtime.compact(hookInput);
      output.context.push(RULES);
    },
    event: runtime.event, dispose: runtime.dispose,
  };
}
