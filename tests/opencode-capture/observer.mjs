import { createHash } from 'node:crypto';
import fs from 'node:fs';

export default { id: 'capture-production-observer', async server(input, options) {
  const { memocap } = await import(options.plugin);
  let sequence = 0;
  const generations = new Map();
  const trace = (phase, request, detail = {}) => {
    if (options.orderLog) fs.appendFileSync(options.orderLog, `${JSON.stringify({ sequence: ++sequence, phase,
      sessionID: request.sessionID, messageID: request.messageID, generation: generations.get(request.sessionID) ?? 0, ...detail })}\n`);
  };
  const contentHash = (args) => createHash('sha256').update(JSON.stringify(args.content)).digest('hex');
  const report = async (event) => {
    const response = await fetch(options.control, { method: 'POST', body: JSON.stringify(event), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`telemetry ${response.status}`);
  };
  const hooks = await memocap(input, { ...options.policy, captureObservation: {
    onLifecycle: (event) => report({ phase: event.phase, parentID: event.parentID, user_id: event.user_id,
      workflow: event.workflow, review_id: event.review_id, clock_domain: event.clock_domain,
      monotonic_ms: event.monotonic_ms, status: event.status, reason: event.reason,
      memory_ids: event.memory_ids, model_calls: event.model_calls, tool_calls: event.tool_calls,
      write_attempts: event.write_attempts }),
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
      generations.set(request.sessionID, (generations.get(request.sessionID) ?? 0) + 1);
      trace('generation', request);
      await report({ phase: 'generation', sessionID: request.sessionID });
      const session = (await input.client.session.get({ path: { id: request.sessionID } })).data;
      const settings = await (await fetch(options.control)).json();
      if (settings.extractGate && session.title.endsWith('extract')) {
        await fetch(`${options.control}/gate?id=${request.sessionID}`, { signal: AbortSignal.timeout(20000) });
      }
    },
    'tool.execute.before'(request, output) {
      if (request.tool !== 'memocap_remember') return hooks['tool.execute.before'](request, output);
      const detail = { callID: request.callID, content_hash: contentHash(output.args) };
      trace('before.enter', request, detail);
      try {
        const result = hooks['tool.execute.before'](request, output);
        trace('before.return', request, detail);
        return result;
      } catch (error) { trace('before.throw', request, { ...detail, code: error.code }); throw error; }
    },
    tool: Object.fromEntries(Object.entries(hooks.tool).map(([name, definition]) => [name, { ...definition,
      async execute(args, context) {
        const detail = name === 'memocap_remember' ? { content_hash: contentHash(args) } : undefined;
        if (detail) trace('execute.enter', context, detail);
        if (name === 'memocap_remember') {
          const settings = await (await fetch(options.control)).json();
          if (settings.handshakeGate) fs.writeFileSync(options.marker, 'handshake');
        }
        if (detail) trace('execute.invoke', context, detail);
        const result = await definition.execute(args, context);
        if (detail) {
          const receipt = JSON.parse(result.output);
          trace('execute.return', context, { ...detail, status: receipt.status, code: receipt.error?.code,
            returned_ids: receipt.returned_ids, readback_status: receipt.readback?.status });
        }
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
