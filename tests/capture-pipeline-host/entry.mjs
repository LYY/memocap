export async function captureEntry(input, options) {
  const [{ createCapture }, { createRecallRuntime }, { createOperations }, { createTools }] = await Promise.all([
    import(new URL('./capture/index.js', options.plugin)), import(new URL('./recall.js', options.plugin)),
    import(new URL('./operations.js', options.plugin)), import(new URL('./tools.js', options.plugin)),
  ]);
  const runtime = createRecallRuntime(input, options);
  const operations = createOperations(runtime);
  const capture = createCapture({ ...input, captureObservation: options.captureObservation }, runtime, operations);
  return { tool: createTools(operations, capture), config: (config) => runtime.config(config),
    'chat.params': capture.params, 'tool.execute.before': capture.before,
    'chat.message': async (request, output) => {
      if (capture.owns(request.sessionID)) return;
      capture.observe(request, output);
      await runtime.capture(request, output);
    },
    'experimental.chat.messages.transform': async (request, output) => {
      capture.messages(output);
      if (!output.messages.some((message) => capture.owns(message.info.sessionID))) await runtime.transform(request, output);
    },
    'experimental.chat.system.transform': capture.system,
    event: (event) => {
      capture.event(event);
      const props = event.event.properties;
      const id = props.sessionID ?? props.info?.sessionID ?? props.part?.sessionID ?? props.info?.id;
      if (!capture.owns(id)) return runtime.event(event);
    },
    dispose: async () => { await capture.dispose(); await runtime.dispose(); },
  };
}
