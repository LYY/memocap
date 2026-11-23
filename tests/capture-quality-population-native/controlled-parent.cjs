const { isDeepStrictEqual } = require('node:util');
const { requireStage, hash, identifier } = require('./value.cjs');
const profile = 'controlled_native_parent_genuine_curator_v1';
const localDimensions = { scripted_root_generations: 'parent_requests', scripted_root_dispatches: 'parent_requests',
  scripted_root_request_bytes: 'provider_request_bytes', scripted_root_response_bytes: 'provider_response_bytes' };

function controlledParent(seam) {
  let root; let packet; let user; let steps; let cursor; let issued; let finished; let stopped;
  let reservations = 0; let dispatches = 0;
  const history = new Map(); const reads = new Map(); const uses = new Set();
  function bind(value) {
    requireStage(identifier(value.root) && (!root || root === value.root), 'controlled_owner');
    requireStage(!packet || finished, 'controlled_unfinished_turn');
    requireStage(Array.isArray(value.operations) && (value.memories === undefined || Array.isArray(value.memories)) &&
      (value.memories ?? []).length <= 2 && (value.memories ?? []).every((memory) => memory && Number.isSafeInteger(memory.id) && memory.id > 0 &&
        typeof memory.placement === 'string' && memory.placement.trim() && ['primary', 'comparison'].includes(memory.role) &&
        ['read', 'recall'].includes(memory.access) && (!Object.hasOwn(memory, 'declaration') ||
          typeof memory.declaration === 'string' && memory.declaration.trim() && memory.access === 'read')) &&
      new Set((value.memories ?? []).map((memory) => memory.id)).size === (value.memories ?? []).length, 'controlled_adoption_packet');
    root = value.root; user = undefined; cursor = 0; issued = undefined; finished = false; reads.clear(); uses.clear();
    packet = { user: value.user, operations: value.operations.map(({ tool, input }) => ({ tool, input: structuredClone(input) })),
      memories: (value.memories ?? []).map(({ id, placement, role, access, declaration, recall_query }) => ({ id, placement, role, access, declaration, recall_query })),
      conversation_assistant: value.conversation_assistant };
    steps = packet.memories.map((memory) => ({ kind: memory.access, memory }));
    requireStage(packet.memories.filter((memory) => memory.role === 'primary').length <= 1, 'controlled_primary');
    steps.push(...packet.memories.filter((memory) => memory.declaration).map((memory) => ({ kind: 'use', memory })));
    steps.push(...packet.operations.map((operation) => ({ kind: 'source', operation })));
  }
  function check() { requireStage(!stopped, stopped); }
  function reserve() {
    check(); requireStage(user && !finished, 'controlled_finished');
    requireStage(reservations === dispatches, 'controlled_unconsumed_generation');
    seam.charge('scripted_root_generations'); reservations++;
  }
  function before(event, args) {
    check();
    requireStage(issued && !issued.started && event.sessionID === root && event.callID === issued.call_id &&
      event.tool === issued.name && isDeepStrictEqual(issued.args, args), 'controlled_tool_join');
    issued.started = true;
  }
  function terminal(part, message) {
    try { acceptTerminal(part, message); }
    catch (error) { stopped ??= error.code ?? 'controlled_receipt_invalid'; throw error; }
  }
  function acceptTerminal(part, message) {
    check();
    if (!issued || part.callID !== issued.call_id) return;
    requireStage(issued.started && message?.sessionID === root && message.parentID === user && part.sessionID === root &&
      part.tool === issued.name && isDeepStrictEqual(issued.args, part.state.input), 'controlled_terminal_join');
    if (issued.terminal) { requireStage(isDeepStrictEqual(issued.terminal, part), 'controlled_terminal_join'); return; }
    issued.terminal = structuredClone(part);
    switch (part.state.status) {
      case 'error': requireStage(typeof part.state.error === 'string', 'controlled_terminal_output');
        issued.output = part.state.error;
        cursor = steps[cursor].kind === 'source' && issued.output !== 'permission_denied' ? cursor + 1 : steps.length; return;
      case 'completed': requireStage(typeof part.state.output === 'string', 'controlled_terminal_output'); issued.output = part.state.output; break;
      default: requireStage(false, 'controlled_terminal_status');
    }
    const step = steps[cursor];
    if (['read', 'recall', 'use'].includes(step.kind)) {
      const receipt = JSON.parse(issued.output);
      requireStage(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'controlled_receipt_invalid');
      if (receipt.status === 'blocked' || receipt.error) { cursor = steps.length; return; }
      switch (step.kind) {
        case 'read': {
          const read = receipt.maintenance_read; const full = receipt.results?.[0];
          requireStage(receipt.status === 'ok' && full?.completeness === 'full' && typeof full.memory?.content === 'string' &&
            full.memory.id === step.memory.id && full.memory.placement === step.memory.placement && identifier(read?.receipt_id) &&
            read.id === full.memory.id && read.placement === full.memory.placement && read.content_hash === hash(full.memory.content), 'controlled_full_read');
          requireStage(![...reads.values()].some((prior) => prior.receipt_id === read.receipt_id), 'controlled_full_read');
          reads.set(`${read.placement}/${read.id}`, { ...read, content: full.memory.content }); break;
        }
        case 'recall': requireStage(receipt.status === 'ok' && receipt.truncated !== true && Array.isArray(receipt.returned_ids) &&
          receipt.returned_ids.every((id) => Number.isSafeInteger(id) && id > 0) &&
          receipt.returned_ids.includes(step.memory.id), 'controlled_recall_missing'); break;
        case 'use': {
          const read = reads.get(`${step.memory.placement}/${step.memory.id}`);
          requireStage(receipt.status === 'used' && identifier(receipt.use_id) && !uses.has(receipt.use_id) &&
            receipt.id === read.id && receipt.placement === read.placement && receipt.content_hash === read.content_hash, 'controlled_use_missing');
          uses.add(receipt.use_id); break;
        }
        default: requireStage(false, 'controlled_step');
      }
    }
    cursor++;
  }
  function next() {
    const step = steps[cursor];
    if (!step) return null;
    switch (step.kind) {
      case 'source': return { name: step.operation.tool, args: { ...step.operation.input,
        ...(step.operation.tool === 'bash' ? { description: 'Read supplied task evidence' } : {}) } };
      case 'read': return { name: 'memocap_read', args: { id: step.memory.id, placement: step.memory.placement } };
      case 'recall':
        requireStage(typeof step.memory.recall_query === 'string' && step.memory.recall_query.trim() &&
          Array.from(step.memory.recall_query).length <= 800, 'controlled_recall_query');
        return { name: 'memocap_recall', args: { query: step.memory.recall_query, placements: [step.memory.placement] } };
      case 'use': {
        const read = reads.get(`${step.memory.placement}/${step.memory.id}`);
        requireStage(read && Array.from(read.content).length <= 800 && read.content.trim(), 'controlled_adoption_body');
        return { name: 'memocap_maintain', args: { operation: 'use', receipt_id: read.receipt_id, id: read.id,
          placement: read.placement, content_hash: read.content_hash, statements: [read.content] } };
      }
      default: requireStage(false, 'controlled_step');
    }
  }
  async function respond(request) {
    check();
    try {
      requireStage(request.method === 'POST' && seam.endpoints.includes(request.url) && new URL(request.url).pathname.endsWith('/responses'), 'controlled_request_route');
      requireStage(user && !finished && reservations === dispatches + 1, 'controlled_generation_missing');
      request.signal.throwIfAborted();
      const chunks = []; let length = 0;
      for await (const chunk of request.body) { length += chunk.byteLength; requireStage(length <= 262144, 'controlled_request_bytes'); chunks.push(chunk); }
      seam.charge('scripted_root_request_bytes', length); seam.charge('total_bytes', length);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requireStage(body.model === 'gpt-6.1-sol' && body.stream === true && Array.isArray(body.input) &&
        !body.previous_response_id && !body.conversation, 'controlled_request_shape');
      requireStage(!issued || issued.terminal, 'controlled_terminal_missing');
      for (const item of body.input.filter((item) => ['function_call', 'function_call_output'].includes(item.type))) {
        const known = history.get(item.call_id);
        requireStage(known && (item.type === 'function_call' ? item.name === known.name &&
          isDeepStrictEqual(JSON.parse(item.arguments), known.args) : item.output === known.output), 'controlled_continuation');
      }
      for (const known of history.values()) {
        requireStage(body.input.filter((item) => item.type === 'function_call' && item.call_id === known.call_id).length === 1 &&
          body.input.filter((item) => item.type === 'function_call_output' && item.call_id === known.call_id).length === 1, 'controlled_continuation');
      }
      const step = next(); const id = `local_${hash(`${root}/${user}`).slice(0, 16)}_${dispatches}`;
      const created = { type: 'response.created', response: { id: `resp_${id}`, created_at: 0, model: body.model } };
      let frames;
      if (step) {
        requireStage(body.tools?.some((tool) => tool.type === 'function' && tool.name === step.name), 'controlled_tool_unavailable');
        const item = { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: step.name, arguments: '' };
        const args = JSON.stringify(step.args);
        frames = [created, { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: args },
          { type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: args, status: 'completed' } }];
        issued = { ...step, call_id: item.call_id }; history.set(item.call_id, issued);
      } else {
        const item = { type: 'message', id: `msg_${id}`, role: 'assistant', phase: 'final_answer' };
        const text = packet.conversation_assistant ?? 'The supplied evidence sequence is finished. No additional outcome is asserted.';
        frames = [created, { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_text.delta', item_id: item.id, delta: text },
          { type: 'response.output_item.done', output_index: 0, item }]; finished = true;
      }
      frames.push({ type: 'response.completed', response: { usage: { input_tokens: 0, output_tokens: 0 } } });
      const bytes = Buffer.from(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
      requireStage(bytes.length <= 262144, 'controlled_response_bytes');
      seam.charge('scripted_root_dispatches'); seam.charge('scripted_root_response_bytes', bytes.length); seam.charge('total_bytes', bytes.length);
      dispatches++; await seam.flush(); request.signal.throwIfAborted();
      return new Response(new ReadableStream({ pull(controller) { request.signal.throwIfAborted(); controller.enqueue(bytes); controller.close(); },
        cancel() { stopped = 'controlled_cancelled'; } }), { headers: { 'content-type': 'text/event-stream' } });
    } catch (error) { stopped = error.code ?? 'controlled_response_unknown'; throw error; }
  }
  return { bind, before, terminal, reserve, respond, check,
    packet: () => packet, root: () => root, user(id) { check(); requireStage(identifier(id) && !user, 'controlled_user'); user = id; },
    stop(reason) { stopped ??= reason; }, snapshot: () => ({ profile, reservations, dispatches, finished: Boolean(finished), stopped: stopped ?? null }) };
}
module.exports = { controlledParent, profile, localDimensions };
