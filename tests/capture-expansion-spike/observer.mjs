import fs from 'node:fs';

export default { id: 'capture-expansion-spike-observer', async server(input, options) {
  const report = async (event) => {
    const response = await fetch(options.control, { method: 'POST', body: JSON.stringify(event), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`spike telemetry ${response.status}`);
  };
  const session = new Proxy(input.client.session, { get(target, method) {
    const original = Reflect.get(target, method);
    if (typeof original !== 'function') return original;
    return async (...args) => {
      const capture = /\/capture\/(?:worker|binding|permission|duplicates|index)\.js:/.test(new Error().stack);
      const result = await original.apply(target, args);
      if (capture) await report({ phase: 'capture.sdk', method: `session.${String(method)}`, request: args[0],
        request_bytes: Buffer.byteLength(JSON.stringify(args[0] ?? null)),
        response: result, returned_count: Array.isArray(result.data) ? result.data.length : result.data == null ? 0 : 1,
        response_bytes: Buffer.byteLength(JSON.stringify(result)) });
      return result;
    };
  } });
  const observed = options.observedModule
    ? (await import(options.observedModule)).createObserved((event) => { void report(event); }) : undefined;
  const { memocap } = await import(options.plugin);
  const measurements = [];
  const hooks = await memocap({ ...input, client: new Proxy(input.client, { get(target, key) {
    return key === 'session' ? session : Reflect.get(target, key);
  } }), spikeObserved: observed }, { captureObservation: observed ? undefined : {
    onMeasure(retained) { measurements.push(report({ phase: 'capture.retention', retained })); },
  } });
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
      const settings = await (await fetch(options.control)).json();
      const current = (await input.client.session.get({ path: { id: request.sessionID } })).data;
      if (settings.extractGate && current.title.endsWith('extract')) {
        await fetch(`${options.control}/gate?id=${request.sessionID}`, { signal: AbortSignal.timeout(20000) });
      }
    },
    tool: Object.fromEntries(Object.entries(hooks.tool).map(([name, definition]) => [name, { ...definition,
      async execute(args, context) {
        let execution = context;
        if (name === 'memocap_remember') {
          const settings = await (await fetch(options.control)).json();
          if (settings.handshakeGate) fs.writeFileSync(options.marker, 'handshake');
          execution = { ...context, async ask(request) {
            await report({ phase: 'native.ask', sessionID: context.sessionID, request });
            return context.ask(request);
          } };
        }
        const result = await definition.execute(args, execution);
        if (name === 'memocap_remember') await report({ phase: 'remember.result', sessionID: context.sessionID, receipt: JSON.parse(result.output) });
        return result;
      },
    }])),
    async event(request) {
      const pending = hooks.event(request);
      await report({ phase: 'host.event', event: request.event });
      await pending;
      await Promise.all(measurements.splice(0));
    },
  };
} };
