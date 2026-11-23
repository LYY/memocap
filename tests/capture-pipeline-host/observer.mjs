import fs from 'node:fs';

export default { id: 'capture-pipeline-observer', async server(input, options) {
  const report = async (event) => {
    const response = await fetch(options.control, { method: 'POST', body: JSON.stringify(event), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`pipeline telemetry ${response.status}`);
  };
  const session = new Proxy(input.client.session, { get(target, method) {
    const original = Reflect.get(target, method);
    if (typeof original !== 'function') return original;
    return async (...args) => {
      const capture = /\/capture\/(?:worker|extraction|binding|permission|duplicates|index)\.js:/.test(new Error().stack);
      const result = await original.apply(target, args);
      if (capture) await report({ phase: 'capture.sdk', method: `session.${String(method)}`, request: args[0],
        request_bytes: Buffer.byteLength(JSON.stringify(args[0] ?? null)), response: result,
        returned_count: Array.isArray(result.data) ? result.data.length : result.data == null ? 0 : 1,
        response_bytes: Buffer.byteLength(JSON.stringify(result)) });
      return result;
    };
  } });
  const measurements = [];
  const nativeRounds = new Map();
  async function nativeInput(kind, sessionID, output) {
    const settings = await (await fetch(options.control)).json();
    const probe = settings.captureNativeInput;
    if (!probe || !sessionID) return;
    const current = (await input.client.session.get({ path: { id: sessionID } })).data;
    if (current?.title !== `memocap capture ${probe.stage}`) return;
    const key = `${sessionID}:${kind}`;
    const round = (nativeRounds.get(key) ?? 0) + 1;
    nativeRounds.set(key, round);
    if (round !== probe.round) return;
    const fragments = probe.surface === 'system_messages' ? [kind === 'system' ? 'pass' : 'word=fixture-native-only'] :
      ['parts', 'accumulated'].includes(probe.surface) ? ['pass', 'word=fixture-native-only'] : ['password=fixture-native-only'];
    if (kind === 'system' && ['system', 'system_messages'].includes(probe.surface)) output.system.push(...fragments);
    else if (kind === 'messages' && probe.surface !== 'system') {
      const messages = output.messages;
      fragments.forEach((text, index) => {
        const message = probe.surface === 'accumulated' ? messages[index] :
          probe.surface === 'system_messages' ? messages[0] : messages.at(-1);
        const template = messages.flatMap((message) => message.parts).find((part) => part.type === 'text');
        if (probe.surface === 'system_messages' || (probe.surface === 'accumulated' && index === 1)) message.parts.unshift({ ...template, text });
        else message.parts.push({ ...template, text });
      });
    } else return;
    await report({ phase: 'native.input.injected', kind, sessionID, surface: probe.surface, round });
  }
  const rootParts = new Map();
  const captureCoordinator = options.captureOnly ? { owns: () => false, async beforeReview(turn) {
    const settings = await (await fetch(options.control)).json();
    if (!settings.coordinatorGate) return;
    await report({ phase: 'coordinator.enter', sessionID: turn.parentID, userID: turn.userID });
    await fetch(`${options.control}/gate?id=coordinator-${turn.parentID}`, { signal: AbortSignal.timeout(45000) });
    await report({ phase: 'coordinator.complete', sessionID: turn.parentID, userID: turn.userID });
    return !settings.coordinatorFalse;
  } } : undefined;
  const { memocap } = options.captureOnly ? { memocap: (input, policy) => import('./entry.mjs').then(({ captureEntry }) => captureEntry(input, { ...policy, plugin: options.plugin })) } : await import(options.plugin);
  const hooks = await memocap({ ...input, client: new Proxy(input.client, { get(target, key) {
    return key === 'session' ? session : Reflect.get(target, key);
   } }), ...(captureCoordinator ? { captureCoordinator } : {}) }, { captureObservation: { onMeasure(retained) { measurements.push(report({ phase: 'capture.retention', retained })); } } });
  return { ...hooks,
    async 'experimental.chat.messages.transform'(request, output) {
      const sessionID = output.messages[0]?.info.sessionID;
      await nativeInput('messages', sessionID, output);
      try { await hooks['experimental.chat.messages.transform'](request, output); }
      catch (error) { await report({ phase: 'input.blocked', kind: 'messages', sessionID, code: error.code }); throw error; }
    },
    async 'experimental.chat.system.transform'(request, output) {
      await nativeInput('system', request.sessionID, output);
      try { await hooks['experimental.chat.system.transform']?.(request, output); }
      catch (error) { await report({ phase: 'input.blocked', kind: 'system', sessionID: request.sessionID, code: error.code }); throw error; }
    },
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
      if (settings.extractGate && current.title.endsWith('extract')) await fetch(`${options.control}/gate?id=${request.sessionID}`, { signal: AbortSignal.timeout(20000) });
    },
    tool: Object.fromEntries(Object.entries(hooks.tool).map(([name, definition]) => [name, { ...definition,
      async execute(args, context) {
        let execution = context;
        if (name === 'memocap_remember') {
          const settings = await (await fetch(options.control)).json();
          if (settings.handshakeGate) fs.writeFileSync(options.marker, 'handshake');
          execution = { ...context, async ask(request) {
            await report({ phase: 'native.ask', sessionID: context.sessionID, request });
            const answer = await context.ask(request);
            if (settings.retractAtAsk) {
              const child = (await input.client.session.get({ path: { id: context.sessionID } })).data;
              const part = rootParts.get(child.parentID);
              if (!part) throw new Error('missing actual observed root part');
              await hooks.event({ event: { type: 'message.part.updated', properties: { part: { ...part, synthetic: true } } } });
              await report({ phase: 'controlled.source_retraction_after_ask', source_id: part.id });
            }
            return answer;
          } };
        }
        const result = await definition.execute(args, execution);
        if (name === 'memocap_remember') await report({ phase: 'remember.result', sessionID: context.sessionID, receipt: JSON.parse(result.output) });
        return result;
      },
    }])),
    async 'chat.message'(request, output) {
      const part = output.parts.find((entry) => entry.type === 'text' && !entry.synthetic && !entry.ignored);
      if (part) rootParts.set(request.sessionID, { ...part, sessionID: request.sessionID, messageID: output.message.id });
      if (rootParts.size > 8) rootParts.delete(rootParts.keys().next().value);
      await hooks['chat.message'](request, output);
    },
    async event(request) {
      const pending = hooks.event(request);
      const settings = await (await fetch(options.control)).json();
      if (settings.replayIdle && request.event.type === 'session.status' && request.event.properties.status.type === 'idle') {
        const current = (await input.client.session.get({ path: { id: request.event.properties.sessionID } })).data;
        if (!current.parentID) {
          hooks.event(request);
          await report({ phase: 'controlled.same_type_idle_replay', sessionID: current.id });
        }
      }
      await report({ phase: 'host.event', event: request.event });
      await pending;
      await Promise.all(measurements.splice(0));
    },
  };
} };
