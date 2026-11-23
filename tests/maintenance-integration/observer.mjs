export default { id: 'maintenance-production-observer', async server(input, options) {
  const report = async (event) => {
    const response = await fetch(options.control, { method: 'POST', body: JSON.stringify(event), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`telemetry ${response.status}`);
  };
  const settings = async () => (await fetch(options.control)).json();
  const client = Object.create(input.client);
  client.session = Object.create(input.client.session);
  for (const method of ['create', 'delete']) client.session[method] = async (args) => {
    const result = await input.client.session[method](args);
    await report({ phase: 'session.lifecycle', method, id: result.data?.id ?? args.path?.id,
      parentID: result.data?.parentID, title: result.data?.title, deleted: method === 'delete' && result.data === true });
    return result;
  };
  client.session.messages = async (args) => {
    await report({ phase: 'session.messages', id: args.path.id });
    return input.client.session.messages(args);
  };
  const { memocap } = await import(options.plugin);
  const hooks = await memocap({ ...input, client }, { maintenanceObservation: report });
  return { ...hooks,
    async config(config) {
      const configuration = await settings();
      const permission = { ...config.permission };
      delete permission['*'];
      config.permission = { ...permission, memocap_recall: { library: 'allow' }, memocap_read: { library: 'allow' },
        memocap_remember: 'deny', memocap_maintain: configuration.permission };
      if (configuration.agentPrompt) config.agent = { ...config.agent, build: { ...config.agent?.build, prompt: configuration.agentPrompt } };
      await hooks.config(config);
    },
    async 'experimental.chat.messages.transform'(request, output) {
      const configuration = await settings();
      const sessionID = output.messages[0]?.info.sessionID;
      const session = sessionID ? await input.client.session.get({ path: { id: sessionID } }) : null;
      if (configuration.childSecret === 'messages' && session?.data?.title.startsWith('memocap maintenance')) {
        output.messages[0].parts.push({ type: 'text', text: 'pass' }, { type: 'text', text: 'word=fixture-only' });
      }
      try { await hooks['experimental.chat.messages.transform'](request, output); }
      catch (error) { await report({ phase: 'input.blocked', kind: 'messages', code: error.code }); throw error; }
      await report({ phase: 'input.messages', sessions: [...new Set(output.messages.map((message) => message.info.sessionID))],
        bytes: Buffer.byteLength(JSON.stringify(output.messages)) });
    },
    async 'experimental.chat.system.transform'(request, output) {
      const configuration = await settings();
      const session = await input.client.session.get({ path: { id: request.sessionID } });
      if (configuration.childSecret === 'system' && session.data?.title.startsWith('memocap maintenance')) {
        output.system.push('password=fixture-only');
        await report({ phase: 'native.input.injected', kind: 'system', sessionID: request.sessionID });
      }
      try { await hooks['experimental.chat.system.transform'](request, output); }
      catch (error) { await report({ phase: 'input.blocked', kind: 'system', sessionID: request.sessionID, code: error.code }); throw error; }
      await report({ phase: 'input.system', sessionID: request.sessionID, bytes: Buffer.byteLength(JSON.stringify(output.system)) });
    },
    async 'chat.params'(request, output) {
      try { await hooks['chat.params'](request, output); }
      catch (error) { await report({ phase: 'generation.blocked', sessionID: request.sessionID, code: error.code }); throw error; }
      await report({ phase: 'generation', sessionID: request.sessionID });
    },
    tool: Object.fromEntries(Object.entries(hooks.tool).map(([name, definition]) => [name, { ...definition,
      async execute(args, context) {
        const realContext = { ...context, async ask(request) {
          await report({ phase: 'ask', sessionID: context.sessionID, request });
          try { await context.ask(request); await report({ phase: 'ask.resolved', sessionID: context.sessionID }); }
          catch (error) { await report({ phase: 'ask.denied', sessionID: context.sessionID }); throw error; }
        } };
        const result = await definition.execute(args, realContext);
        await report({ phase: 'tool.result', name, args, sessionID: context.sessionID, messageID: context.messageID,
          result: JSON.parse(result.output) });
        return result;
      },
    }])),
    async event(request) {
      const pending = hooks.event(request);
      if (['permission.asked', 'permission.updated'].includes(request.event.type)) await report({ phase: 'permission.asked', event: request.event });
      if (request.event.type === 'message.part.updated' && request.event.properties.part.type === 'tool') {
        await report({ phase: 'native.tool', part: request.event.properties.part });
      }
      await pending;
    },
  };
} };
