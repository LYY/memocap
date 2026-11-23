const { matchesInput } = require('./carrier.cjs');
const { createWorkflows } = require('./workflows.cjs');
const { captureObservation } = require('./execution-observation.cjs');
const { requireStage, hash, identifier, size } = require('./value.cjs');
const { boundSDK } = require('./sdk-boundary.cjs');
const { observeNativeInvoke } = require('./native-boundary.cjs');
const { productionFactory } = require('./production-factory.cjs');
const { isDeepStrictEqual } = require('node:util');
const { controlledParent, profile } = require('./controlled-parent.cjs');
const { correlation } = require('./egress.cjs');
const { responseMeter } = require('./response-meter.cjs');
const { completion, reply, observeChild } = require('./response-metadata.cjs');

async function createFixture(input, seam) {
  requireStage(seam && typeof seam.writeCarrier === 'function' && typeof seam.binding === 'function', 'explicit_fixture_seam_required');
  const factory = seam.factory ?? productionFactory;
  requireStage(seam.factory || typeof seam.invoke === 'function' && typeof seam.database === 'function', 'explicit_production_invoke_required');
  const children = new Map();
  const messages = new Map();
  const sourceCalls = new Map();
  let eventTail = Promise.resolve();
  let completedProjection;
  let active;
  let packet;
  let target;
  requireStage(!seam.execution_profile || seam.execution_profile === profile, 'controlled_profile');
  const controlled = seam.execution_profile ? controlledParent({ endpoints: seam.endpoints,
    charge: (...args) => target.charge(...args), flush: () => seam.flush() }) : null;
  const ownerOf = (id) => {
    const child = children.get(id);
    return child && child.root === active?.root && child.user === active?.user ? child : id === active?.root ? active : null;
  };
  const workflows = createWorkflows(seam.clock, seam.captureExecutionMs, seam.maintenanceExecutionMs);
  let parentCalls = 0;
  let nativeBinding;
  const sdk = controlled ? new Proxy(input.client, { get(client, group) {
    const member = Reflect.get(client, group);
    if (!['session', 'config', 'app', 'tool', '_client'].includes(group) || !member) return member;
    return new Proxy(member, { get(object, key) {
      const method = Reflect.get(object, key);
      return typeof method === 'function' ? async (...args) => { await seam.flush(); return method.apply(object, args); } : method;
    } });
  } }) : input.client;
  const base = boundSDK(sdk, (...args) => target ? target.charge(...args) : seam.charge(...args));
  const client = Object.create(base);
  Object.defineProperty(client, 'session', { value: Object.create(base.session) });
  const record = (kind, details = {}, binding = active) => {
    requireStage(binding, 'fixture_active_review_missing');
    target.record({ kind, root: binding.root, user: binding.user, workflow: binding.workflow, ...details });
  };
  const metering = responseMeter(record, ownerOf);
  client.session.create = async (request) => {
    controlled?.check();
    requireStage(target.reviewAllowed(), 'review_not_scheduled');
    requireStage(active?.user && request.body?.parentID === active.root, 'child_binding_or_budget');
    const owner = workflows.child(active, request.body.title);
    target.charge('children');
    const response = await base.session.create(request);
    requireStage(identifier(response.data?.id) && !response.error, 'child_creation_unknown');
    requireStage(response.data.id !== active.root && !children.has(response.data.id), 'child_creation_unknown');
    children.set(response.data.id, { ...active, owner, workflow: owner.workflow, title: request.body.title,
      session: response.data.id, calls: 0, pending: 0, parts: new Map(), completions: new Set() });
    return response;
  };
  client.session.prompt = async (request) => {
    controlled?.check();
    const child = children.get(request.path.id);
    if (controlled) requireStage(ownerOf(request.path.id) === child && child, 'controlled_owner');
    requireStage(child && ++child.calls <= 3 && size(request.body) <= 65536, 'child_prompt_budget');
    const response = await base.session.prompt(request);
    const observed = await reply(response);
    if (ownerOf(request.path.id) === child) record('model.response', { ...observed, session: request.path.id }, child);
    return response;
  };
  client.session.messages = async (request) => {
    if (controlled) requireStage(ownerOf(request.path.id), 'controlled_owner');
    requireStage(children.has(request.path.id), 'parent_history_forbidden');
    const response = await base.session.messages(request);
    requireStage(Array.isArray(response.data) && response.data.length <= 16 && size(response.data) <= 32768 &&
      response.data.every((message) => message.parts?.length <= 24), 'child_history_budget');
    return response;
  };
  client.session.delete = async (request) => {
    const response = await base.session.delete(request);
    if (!response.error && response.data === true) children.delete(request.path.id);
    return response;
  };
  const invoke = seam.invoke ? observeNativeInvoke(seam.invoke, { database: seam.database,
    charge: (...args) => (target ?? seam).charge(...args), record: (event) => {
      if (event.kind === 'native.dispatch') workflows.dispatch(event);
      target.record(event);
    },
    binding(argv) {
      const at = argv.indexOf('--caller-json');
      const caller = at >= 0 ? JSON.parse(argv[at + 1]) : null;
      if (!caller) {
        requireStage(argv[0] !== 'remember' && !(argv[0] === 'organize' && argv[1] === 'maintain'), 'write_workflow_unobserved');
        return nativeBinding;
      }
      const owner = controlled ? ownerOf(caller.session_id) : children.get(caller.session_id) ?? active;
      requireStage(owner, 'native_caller_unobserved');
      if (argv[0] === 'remember' || argv[0] === 'organize' && argv[1] === 'maintain') {
        requireStage(owner.workflow === (argv[0] === 'remember' ? 'capture' : 'maintenance'), 'write_workflow_unobserved');
      }
      return { ...owner, session: caller.session_id, message: caller.message_id,
        tool: nativeBinding?.session === caller.session_id && nativeBinding?.message === caller.message_id ? nativeBinding.tool : null };
    } }) : undefined;
  const hooks = await factory({ ...input, client }, { automatic: false, invoke, captureExecutionMs: seam.captureExecutionMs, maintenanceExecutionMs: seam.maintenanceExecutionMs,
    captureObservation: captureObservation(workflows, record, seam.review),
    maintenanceObservation(event) {
      if (event.phase === 'review.started') workflows.start({ root: event.parentID, user: event.user_id }, 'maintenance', event.execution_profile?.maintenance_ms);
      if (event.phase?.startsWith('review.')) { record(event.phase, event, { root: event.parentID, user: event.user_id, workflow: 'maintenance' }); return; }
      const stage = { raw_proposal: 'raw', validated_decision: 'validated', support_assessment: 'support', issuance: 'issued' }[event.stage];
      if (stage) record(stage, { observation: event }, { root: event.parentID, user: event.user_id, workflow: 'maintenance' });
      else if (event.phase === 'maintenance.review') seam.review?.({ ...event, workflow: 'maintenance' });
    } });
  const call = async (name, ...args) => { if (hooks[name]) return hooks[name](...args); };
  const tool = Object.fromEntries(Object.entries(hooks.tool ?? {}).map(([name, definition]) => [name, { ...definition,
    async execute(args, context) {
      const binding = controlled ? ownerOf(context.sessionID) : children.get(context.sessionID) ?? active;
      requireStage(binding, 'native_caller_unobserved');
      nativeBinding = { ...binding, session: context.sessionID, message: context.messageID, tool: name };
      seam.binding(nativeBinding);
      const value = await definition.execute(args, { ...context, async ask(request) {
        try { await context.ask(request); record('permission', { outcome: 'resolved', permission: request.permission,
          session: context.sessionID, message: context.messageID, tool: name, request_hash: hash(request) }, binding); }
        catch (error) { record('permission', { outcome: 'denied', permission: request.permission,
          session: context.sessionID, message: context.messageID, tool: name }, binding); controlled?.stop('controlled_permission_denied'); throw error; }
      } });
      const receipt = JSON.parse(typeof value === 'string' ? value : value.output);
      record('tool.output', { tool: name, args, receipt, session: context.sessionID, message: context.messageID }, binding);
      if (receipt.maintenance_read) {
        const result = receipt.results?.[0];
        requireStage(receipt.status === 'ok' && result?.completeness === 'full', 'maintenance_full_read_unobserved');
        record('memory.read', { record: result.memory, ...receipt.maintenance_read, completeness: result.completeness }, binding);
      }
      if (name === 'memocap_recall') record('memory.recall', { ids: receipt.returned_ids ?? [] }, binding);
      if (name === 'memocap_maintain' && args.operation === 'use' && receipt.status === 'used') {
        record('memory.use', { ...receipt, receipt_id: args.receipt_id, content_hash: args.content_hash }, binding);
      }
      return value;
    } }]));
  return { ...hooks, tool,
    bind(value, boundary) { packet = value; target = boundary; active = null; parentCalls = 0;
      if (controlled) { controlled.bind(value); active = { root: value.root, user: null }; }
      completedProjection = undefined; messages.clear(); sourceCalls.clear(); metering.reset(); },
    observedProvider: metering.observedProvider,
    async controlledProvider(input, init, forward) {
      controlled.check();
      const request = new Request(input, init); const id = request.headers.get(correlation); const owner = ownerOf(id);
      requireStage(controlled && owner && active?.user, 'controlled_owner');
      if (id === active.root) { request.headers.delete(correlation); return controlled.respond(request); }
      requireStage(owner.pending > 0, 'controlled_child_generation_missing'); owner.pending--;
      return metering.forward(request, owner, forward);
    },
    async 'chat.message'(event, output) {
      if (controlled) requireStage(ownerOf(event.sessionID), 'controlled_owner');
      if (!children.has(event.sessionID)) {
        if (controlled) {
          const clean = (await import('../../plugin/capture/screen.js')).clean;
          requireStage(clean(JSON.stringify(controlled.packet())), 'screened_whole_unit'); controlled.user(output.message.id);
        }
        await target.user({ message: { ...output.message, sessionID: event.sessionID }, parts: output.parts });
        active = { root: event.sessionID, user: output.message.id };
        seam.binding(active);
      }
      await call('chat.message', event, output);
    },
    async 'chat.params'(event, output) {
      controlled?.check();
      const clean = (await import('../../plugin/capture/screen.js')).clean;
      requireStage(clean(packet.user), 'screened_whole_unit');
      if (controlled) requireStage(ownerOf(event.sessionID)?.user === active?.user && active?.user, 'controlled_owner');
      if (children.has(event.sessionID)) workflows.generation(children.get(event.sessionID).owner);
      else if (!controlled) requireStage(++parentCalls <= 1 + packet.operations.length + (packet.memories?.length ?? 0) +
        (packet.memories?.filter((memory) => memory.declaration).length ?? 0), 'parent_generation_budget');
      if (controlled && event.sessionID === active.root) controlled.reserve();
      else { target.charge('requests'); target.charge(children.has(event.sessionID) ? 'worker_requests' : 'parent_requests'); }
      try {
        if (controlled) await seam.flush();
        await call('chat.params', event, output);
        if (controlled && children.has(event.sessionID)) children.get(event.sessionID).pending++;
      } catch (error) { controlled?.stop('controlled_generation_refused'); throw error; }
    },
    async 'tool.execute.before'(event, output) {
      await eventTail;
      if (controlled && event.sessionID === active?.root) controlled.before(event, output.args);
      await call('tool.execute.before', event, output);
      if (!['read', 'bash'].includes(event.tool)) return;
      requireStage(active?.root === event.sessionID && identifier(event.callID), 'unmapped_native_source_request');
      const operation = packet.operations.find((entry) => entry.tool === event.tool && matchesInput(event.tool, entry.input, output.args));
      requireStage(operation, 'unmapped_native_source_request');
      requireStage(!sourceCalls.has(event.callID) && sourceCalls.size < packet.operations.length, 'native_call_custody');
      sourceCalls.set(event.callID, { operation });
      const translation = await target.prepare(operation.token);
      await seam.writeCarrier(translation);
      if (translation.failure) throw new Error(translation.text);
    },
    event(event) {
      const project = async () => {
        const actual = event.event;
        const info = actual.properties?.info;
        const part = actual.properties?.part;
        const child = children.get(info?.sessionID ?? part?.sessionID);
        if (child && ownerOf(child.session) === child) observeChild(record, child, actual);
        if (controlled && actual.properties?.sessionID === active?.root && ['session.error', 'session.deleted'].includes(actual.type)) controlled.stop('controlled_cancelled');
        const projection = info && { id: info.id, sessionID: info.sessionID, parentID: info.parentID,
          role: info.role, finish: info.finish, error: info.error, completed: info.time?.completed };
        if (completedProjection && info && (info.id === completedProjection.id ||
          info.sessionID === active.root && info.role === 'assistant')) {
          requireStage(isDeepStrictEqual(completedProjection, projection), 'native_completion_missing');
        }
        if (active && info?.sessionID === active.root && info.role === 'assistant' && info.parentID === active.user) {
          const pair = metering.parent(active, info);
          if (pair) record('model.parent.response', { ...pair, ...completion(info) });
          requireStage(messages.size < 16 || messages.has(info.id), 'root_message_budget');
          messages.set(info.id, info);
          if (!completedProjection && info.finish === 'stop' && (info.time?.completed !== undefined || info.error)) {
            await target.complete(info);
            completedProjection = structuredClone(projection);
          }
        }
        if (active && part && (sourceCalls.get(part.callID)?.terminal ||
          (part.sessionID === active.root && ['read', 'bash'].includes(part.tool) || sourceCalls.has(part.callID)) &&
          ['completed', 'error'].includes(part.state?.status))) {
          const source = sourceCalls.get(part.callID);
          requireStage(source && part.sessionID === active.root, 'native_call_custody');
          if (source.terminal) requireStage(isDeepStrictEqual(source.terminal, part), 'native_call_custody');
          else {
            const message = messages.get(part.messageID);
            requireStage(message, 'native_message_stage_missing');
            const { operation } = source;
            requireStage(operation.tool === part.tool && matchesInput(part.tool, operation.input, part.state.input), 'native_call_custody');
            await target.tool({ userID: active.user, message, part });
            source.terminal = structuredClone(part);
          }
        }
        if (controlled && part?.type === 'tool' && ['completed', 'error'].includes(part.state?.status)) controlled.terminal(part, messages.get(part.messageID));
        await call('event', event);
      };
      const pending = eventTail.then(project, project);
      eventTail = pending;
      return pending;
    },
    state: () => ({ children: [...children.keys()], active: structuredClone(active), workflows: workflows.snapshot(), controlled: controlled?.snapshot() }),
  };
}
module.exports = { createFixture };
