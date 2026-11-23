import { createTools } from "./tools.js";

export function composeHooks({ runtime, operations, commands, maintenance, capture, policy }) {
  const owns = (id) => capture.owns(id) || maintenance.owns(id);
  return {
    tool: createTools(operations, capture, maintenance), config: async (config) => { runtime.config(config); maintenance.config(config); await commands.config(config); },
    "chat.params": (input, output) => { maintenance.params(input, output); capture.params(input, output); },
    "tool.execute.before": (input, output) => { maintenance.before(input, output); capture.before(input, output); },
    "tool.execute.after": async (input, output) => {
      if (!["memocap_maintain", "memocap_organize", "memocap_scope", "memocap_recall", "memocap_read", "memocap_remember"].includes(input.tool) ||
          typeof output.metadata?.memocap_complete_output !== "string") return;
      output.output = output.metadata.memocap_complete_output;
      output.metadata.truncated = false;
      delete output.metadata.memocap_complete_output;
      delete output.metadata.outputPath;
    },
    "command.execute.before": commands.execute,
    "chat.message": async (hookInput, output) => {
      if (owns(hookInput.sessionID)) return;
      maintenance.observe(hookInput, output);
      capture.observe(hookInput, output);
      await runtime.capture(hookInput, output);
    },
    "experimental.chat.messages.transform": async (hookInput, output) => {
      maintenance.messages(output);
      capture.messages(output);
      if (output.messages.some((message) => owns(message.info.sessionID))) return;
      await runtime.transform(hookInput, output);
    },
    "experimental.chat.system.transform": (input, output) => { maintenance.system(input, output); capture.system(input, output); },
    "experimental.session.compacting": async (hookInput, output) => {
      await runtime.compact(hookInput);
      output.context.push(policy.rules);
    },
    event: (event) => {
      maintenance.event(event);
      const props = event.event.properties;
      const id = props.sessionID ?? props.info?.sessionID ?? props.part?.sessionID ?? props.info?.id;
      if (!maintenance.owns(id)) capture.event(event);
      if (!owns(id)) return runtime.event(event);
    },
    dispose: async () => { await maintenance.dispose(); await capture.dispose(); await runtime.dispose(); },
  };
}
