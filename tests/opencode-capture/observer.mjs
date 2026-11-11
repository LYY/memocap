import fs from 'node:fs';

export default { id: 'capture-production-observer', async server(input, options) {
  const { memocap } = await import(options.plugin);
  const hooks = await memocap(input, options.policy ?? {});
  const report = async (event) => {
    const response = await fetch(options.control, { method: 'POST', body: JSON.stringify(event), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`telemetry ${response.status}`);
  };
  return { ...hooks,
    async config(config) {
      config.permission.memocap_recall = { library: 'allow' };
      config.permission.memocap_read = { library: 'allow' };
      await hooks.config(config);
    },
    async 'chat.params'(request, output) {
      try { await hooks['chat.params'](request, output); }
      catch (error) { await report({ phase: 'generation.blocked', sessionID: request.sessionID, code: error.code }); throw error; }
      await report({ phase: 'generation', sessionID: request.sessionID });
      const session = (await input.client.session.get({ path: { id: request.sessionID } })).data;
      const settings = await (await fetch(options.control)).json();
      if (settings.extractGate && session.title.endsWith('extract')) {
        await fetch(`${options.control}/gate?id=${request.sessionID}`, { signal: AbortSignal.timeout(20000) });
      }
    },
    tool: Object.fromEntries(Object.entries(hooks.tool).map(([name, definition]) => [name, { ...definition,
      async execute(args, context) {
        if (name === 'memocap_remember') {
          const settings = await (await fetch(options.control)).json();
          if (settings.handshakeGate) fs.writeFileSync(options.marker, 'handshake');
        }
        const result = await definition.execute(args, context);
        if (name === 'memocap_remember') await report({ phase: 'remember.result', sessionID: context.sessionID, receipt: JSON.parse(result.output) });
        return result;
      },
    }])),
    async event(request) {
      const pending = hooks.event(request);
      const settings = await (await fetch(options.control)).json();
      if (settings.replayIdle && request.event.type === 'session.status' && request.event.properties.status.type === 'idle') {
        const session = (await input.client.session.get({ path: { id: request.event.properties.sessionID } })).data;
        if (!session.parentID) {
          hooks.event(request);
          await report({ phase: 'controlled.same_type_idle_replay', sessionID: session.id });
        }
      }
      await report({ phase: 'host.event', event: request.event });
      await pending;
    },
  };
} };
