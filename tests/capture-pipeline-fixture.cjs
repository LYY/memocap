const { readObservation, commandObservation } = require('./capture-source-host/synthetic.cjs');
const { createHash } = require('node:crypto');

const ref = (source) => ({ source_id: source.source_id, content_hash: source.content_hash, span: source.span, quote: source.text });
async function fixture(t, options = {}) {
  const { createCapture } = await import('../plugin/capture/index.js');
  const { CaptureStop } = await import('../plugin/capture/contract.js');
  const calls = [];
  const states = new Map();
  const reviews = [];
  const memories = new Map();
  const histories = new Map();
  let current;
  let pending;
  let serial = 0;
  let capture;
  const permission = [{ permission: 'memocap_remember', pattern: '*', action: 'allow' }];
  const state = (id) => {
    if (!states.has(id)) states.set(id, { generation: 1, targets: [{ repository_id: 'repository:fixture' }] });
    return states.get(id);
  };
  const client = {
    _client: { get: async () => ({ data: { healthy: true, version: '1.19.3' } }) },
    tool: { ids: async () => ({ data: ['read', 'bash', 'memocap_remember'] }) },
    app: { agents: async () => ({ data: [{ name: 'build', permission }] }) },
    session: {
      get: async ({ path }) => ({ data: options.sessionData ?? (options.omitSessionPermission ? { id: path.id } : { id: path.id, permission }) }),
      abort: async ({ path }) => { calls.push({ type: 'abort', id: path.id }); return { data: true }; },
      create: async ({ body }) => {
        const id = `child${++serial}`;
        calls.push({ type: 'child', id, stage: body.title.split(' ').at(-1) });
        return { data: { id } };
      },
      messages: async ({ path }) => {
        calls.push({ type: 'history', id: path.id });
        return { data: [{ info: { id: 'commit_message' }, parts: [{ type: 'tool', tool: 'memocap_remember', callID: 'call', state: { status: 'running', input: current } }] }] };
      },
      prompt: async ({ path, body, signal }) => {
        const history = histories.get(path.id) ?? [];
        histories.set(path.id, history);
        const requestPacket = JSON.parse(body.parts[0].text);
        const original = history.find((message) => message.info.role === 'user' &&
          createHash('sha256').update(message.parts[0].text).digest('hex') === requestPacket.evidence_packet_sha256);
        const packet = original ? { ...JSON.parse(original.parts[0].text), ...requestPacket } : requestPacket;
        history.push({ info: { id: `message_${history.length}`, sessionID: path.id, role: 'user', system: body.system },
          parts: structuredClone(body.parts) });
        if (options.nativeHistory) {
          capture.messages({ messages: structuredClone(history) });
          capture.system({ sessionID: path.id }, { system: [body.system] });
        }
        capture.params({ sessionID: path.id }, {});
        calls.push({ type: 'generation', id: path.id, packet, requestPacket, serialized: body.parts[0].text, model: body.model, agent: body.agent });
        await options.beforeGeneration?.({ packet, requestPacket, history: structuredClone(history), signal, capture });
        if (packet.content) {
          current = packet;
          capture.before({ sessionID: path.id, tool: 'memocap_remember', callID: 'call' });
          await capture.execute(packet, { sessionID: path.id, messageID: 'commit_message', abort: new AbortController().signal, ask: async () => {
            calls.push({ type: 'ask' });
            if (options.deny) throw new CaptureStop('native_permission_denied', 'denied');
           } });
          await options.afterExecute?.(capture, path.id);
           try { capture.params({ sessionID: path.id }, {}); } catch (error) { calls.push({ type: 'blocked', code: error.code }); }
          return { data: { info: { finish: 'stop' }, parts: [] } };
        }
        let reply;
        if (packet.candidate) {
          const citations = packet.candidate.statements.flatMap((statement) => statement.citations);
          const prior = citations.some((citation) => packet.sources.find((source) => source.source_id === citation.source_id).user_id !== packet.current_user_id);
          const expectedPacket = { evidence_packet_sha256: createHash('sha256').update(original.parts[0].text).digest('hex'),
            persisted_body: packet.persisted_body, candidate: packet.candidate,
            citation_roles: packet.candidate.statements.flatMap((statement, statement_index) => statement.citations.map((citation, citation_index) => ({
              statement_index, citation_index, role: packet.sources.find((source) => source.source_id === citation.source_id).user_id === packet.current_user_id ? 'current' : 'prior' }))) };
          const witnessID = createHash('sha256').update(JSON.stringify(expectedPacket)).digest('hex');
          const hasPriorSources = packet.sources.some((source) => source.user_id !== packet.current_user_id);
          reply = { memory: { status: options.memory ?? 'accept' }, statements: packet.candidate.statements.map((_, index) => ({ index, status: options.support ?? 'supported' })),
            continuity: hasPriorSources ? { status: prior ? options.continuity ?? 'supported' : 'standalone', witness_id: witnessID } : { status: 'current' } };
          if (options.assess) reply = options.assess(packet, reply);
        } else {
          const sources = packet.sources.filter((source) => source.user_id === packet.current_user_id);
          reply = options.propose ? options.propose(packet) : { candidates: [{ statements: [{ text: options.statement ?? 'Prefer concise Chinese for future responses.', citations: [ref(sources[0])] }] }] };
        }
        const parts = [{ type: 'text', text: JSON.stringify(reply) }];
        history.push({ info: { id: `message_${history.length}`, sessionID: path.id, role: 'assistant' }, parts });
        return { data: { info: { finish: 'stop' }, parts } };
      },
    },
  };
  const runtime = { warnings: [], context: async (id) => state(id),
    readPermission: { check: async () => {}, authorize: async () => {} }, recall: async () => ({ status: 'empty', results: [] }),
    request: async (_state, args) => { const review = JSON.parse(args.at(-1)); reviews.push(review); pending.resolve(review); return {}; } };
  const operations = { freezeCapture: async (context, binding) => ({ execute: async () => {
    await binding.guard('before_ask');
    await options.beforeAsk?.();
    await context.ask();
    await binding.guard('after_ask');
    options.beforeSpawn?.(capture);
    binding.beforeSpawn();
     calls.push({ type: 'write', content: binding.content });
     memories.set(1, { id: 1, placement: binding.target.placement, content: binding.content, tags: binding.tags.join(',') });
    await options.afterSpawn?.(capture);
    calls.push({ type: 'readback' });
     return { returned_ids: [1], readback: { status: options.unknown ? 'failed' : 'ok',
       results: [{ memory: structuredClone(memories.get(1)) }] } };
  } }) };
  capture = createCapture({ client, captureExecutionMs: options.captureExecutionMs, captureCoordinator: options.coordinator, captureObservation: {
    clock: options.observationClock, onTimer: options.onTimer, onDecision: options.onDecision, onLifecycle: options.onLifecycle, onReview: options.onReview } }, runtime, operations);
  t.after(() => capture.dispose());
  async function turn(id, text, extras = []) {
    pending = Promise.withResolvers();
    capture.observe({ sessionID: 'parent', agent: 'build', model: { providerID: 'wire', modelID: 'wire-model' } },
      { message: { id, role: 'user' }, parts: [{ id: `text_${id}`, type: 'text', text }] });
    const assistant = { id: `assistant_${id}`, sessionID: 'parent', role: 'assistant', parentID: id, time: { created: 1, completed: 3 }, finish: 'stop' };
    capture.event({ event: { type: 'message.updated', properties: { info: assistant } } });
    for (const extra of extras) {
      const observation = extra.kind === 'command' ? commandObservation(extra.text) : readObservation(extra.text);
      const part = { ...observation.part, id: `part_${id}_${extras.indexOf(extra)}`, sessionID: 'parent', messageID: assistant.id };
      if (extra.change) extra.change(part);
      capture.event({ event: { type: 'message.part.updated', properties: { part } } });
    }
    await options.beforeIdle?.({ capture, id, assistant, runtime });
    capture.event({ event: { type: 'session.status', properties: { sessionID: 'parent', status: { type: 'idle' } } } });
    return pending.promise;
  }
  return { capture, calls, reviews, turn, state, options, histories };
}
module.exports = { fixture, ref };
