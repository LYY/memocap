const fs = require('node:fs');
const { SharedBudget } = require('./journal.cjs');
const { nativeFetch, correlation } = require('./provider.cjs');
const { materialize } = require('./support.cjs');
const { receipt, maintenance, digest, usage } = require('./projection.cjs');
const { CanaryBlocked } = require('./entry.cjs');

async function createFixture(input, testing) {
  const settings = testing?.settings ?? JSON.parse(fs.readFileSync(process.env.MEMOCAP_CANARY_CONTROL, 'utf8'));
  const budget = testing?.budget ?? new SharedBudget(settings.attempt);
  const factory = testing?.factory ?? (await import('../../plugin/cli.js')).memocap;
  const clean = testing?.clean ?? (await import('../../plugin/capture/screen.js')).clean;
  const fetchTarget = testing?.fetchTarget ?? globalThis;
  const originalFetch = fetchTarget.fetch;
  const fetches = nativeFetch({ budget, providerDestinations: settings.providerDestinations,
    authDestinations: settings.authDestinations, transport: originalFetch.bind(fetchTarget),
    controlOrigin: input.serverUrl.origin });
  fetchTarget.fetch = fetches.global;
  const extractions = new Map();
  const client = Object.create(input.client);
  Object.defineProperty(client, 'session', { value: Object.create(input.client.session) });
  client.session.create = async (request) => {
    const title = request.body?.title;
    const stage = title === 'memocap capture extract' ? 'extract' :
      title === 'memocap capture commit' ? 'commit' : title === 'memocap maintenance review' ? 'maintenance_review' :
        title === 'memocap maintenance commit' ? 'maintenance_commit' : null;
    const parent = request.body?.parentID;
    const owner = budget.snapshot().reviews[budget.snapshot().roots[parent]];
    if (!stage || !owner) { budget.stop('unexpected_child'); throw new CanaryBlocked('unexpected_child'); }
    if (stage === 'commit' && owner.slot) throw new CanaryBlocked('support_only_zero_writes');
    budget.reserveChild(parent);
    let result;
    try { result = await input.client.session.create(request); }
    catch { budget.stop('child_creation_uncertain'); throw new CanaryBlocked(budget.snapshot().terminal); }
    if (result.error || !result.data?.id) {
      budget.stop('child_creation_uncertain'); throw new CanaryBlocked('child_creation_uncertain');
    }
    budget.bindChild(result.data.id, parent, stage);
    if (stage === 'extract') extractions.set(result.data.id, { calls: 0, root: parent });
    return result;
  };
  client.session.prompt = async (request) => {
    const id = request.path.id;
    const stage = extractions.get(id);
    if (stage) {
      stage.calls++;
      const packet = JSON.parse(request.body.parts.find((part) => part.type === 'text').text);
      if (!clean(packet)) { budget.stop('secret'); throw new CanaryBlocked('secret'); }
      const active = budget.snapshot().active;
      if (stage.calls === 1) {
        budget.event({ kind: 'capture.packet', root: stage.root, session: id, packet });
        if (active?.challenge) {
          const current = packet.sources.find((source) => source.source_id && source.user_id === packet.current_user_id &&
            source.kind === 'user_statement');
          if (!current || digest(current.text) !== active.user_hash) throw new CanaryBlocked('original_task_binding_unavailable');
          stage.injection = JSON.stringify(materialize(active.challenge, settings.contract, packet));
        }
      } else if (stage.calls === 2 && active?.challenge) budget.support(id);
      else if (stage.calls > 2) { budget.stop('extraction_stage_budget'); throw new CanaryBlocked('extraction_stage_budget'); }
    }
    budget.event({ kind: 'generation.request', session: id, stage: stage?.calls ?? null,
      prompt_hash: digest(request.body.system ?? ''), model_hash: digest(request.body.model ?? null),
      input_hash: digest(request.body.parts) });
    let result;
    try { result = await input.client.session.prompt(request); }
    catch { budget.stop('dispatch_uncertain'); throw new CanaryBlocked(budget.snapshot().terminal); }
    if (result.error) { budget.stop('native_prompt_failed'); throw new CanaryBlocked(budget.snapshot().terminal); }
    if (stage) {
      const text = result.data?.parts?.filter((part) => part.type === 'text').map((part) => part.text).join('');
      budget.event({ kind: stage.calls === 1 ? 'extraction.result' : 'support.result', root: stage.root,
        session: id, slot: budget.snapshot().sessions[id]?.slot ?? null,
        finish: result.data?.info?.finish ?? null, error: Boolean(result.data?.info?.error),
        usage: result.data?.info ? usage(result.data.info) : null,
        text: typeof text === 'string' && text.length <= 16000 && clean(text) ? text : null });
    }
    return result;
  };
  let hooks;
  try {
    hooks = await factory({ ...input, client }, { automatic: false,
      maintenanceObservation: (event) => budget.event(maintenance(event)),
      captureObservation: (event) => budget.event({ kind: 'capture.runtime', phase: event.phase ?? null,
        session: event.parentID ?? null, fingerprint: digest(event) }) });
  } catch (error) { fetchTarget.fetch = originalFetch; throw error; }
  const call = async (name, args) => { if (hooks[name]) await hooks[name](...args); };
  const tool = Object.fromEntries(Object.entries(hooks.tool ?? {}).map(([name, definition]) => [name, {
    ...definition,
    async execute(args, context) {
      const binding = budget.snapshot().sessions[context.sessionID];
      const value = await definition.execute(args, { ...context, ask: async (request) => {
        try {
          await context.ask(request);
          budget.event({ kind: 'native.ask', session: context.sessionID, message: context.messageID,
            permission: request.permission, proposal_id: request.metadata?.proposal_id ?? null, outcome: 'resolved' });
        } catch (error) {
          budget.event({ kind: 'native.ask', session: context.sessionID, message: context.messageID,
            permission: request.permission, proposal_id: request.metadata?.proposal_id ?? null, outcome: 'denied' });
          budget.stop('permission_denied'); throw error;
        }
      } });
      const raw = JSON.parse(typeof value === 'string' ? value : value.output);
      if (!clean(raw)) { budget.stop('secret'); throw new CanaryBlocked('secret'); }
      budget.event({ kind: 'tool.receipt', tool: name, root: binding?.root ?? context.sessionID,
        session: context.sessionID, message: context.messageID, receipt: receipt(raw) });
      return value;
    },
  }]));
  return { ...hooks, tool,
    async 'tool.execute.before'(event, output) {
      await call('tool.execute.before', [event, output]);
      if (event.tool === 'memocap_remember' || event.tool === 'memocap_organize') {
        budget.event({ kind: 'native.tool_before', session: event.sessionID, call: event.callID,
          tool: event.tool, input_hash: digest(output.args) });
      }
    },
    async config(config) {
      await call('config', [config]);
      for (const provider of Object.values(config.provider ?? {})) {
        provider.options ??= {};
        provider.options.fetch = fetches.provider;
        provider.options.maxRetries = 0;
      }
      budget.event({ kind: 'provider.hook_installed' });
    },
    async 'chat.message'(event, output) {
      if (!budget.snapshot().sessions[event.sessionID]?.stage) {
        const delivery = budget.snapshot().delivery;
        const parts = output.parts.filter((part) => part.type === 'text');
        if (delivery?.session !== event.sessionID || parts.length !== 1 || digest(parts[0].text) !== delivery.user_hash) {
          budget.stop('unexpected_root_input'); throw new CanaryBlocked('unexpected_root_input');
        }
        budget.root(event.sessionID, output.message.id, budget.snapshot().active?.slot ?? null);
      }
      await call('chat.message', [event, output]);
    },
    async 'chat.params'(event, output) {
      budget.generation(event.sessionID);
      await call('chat.params', [event, output]);
      budget.event({ kind: 'generation.params', session: event.sessionID,
        values: Object.fromEntries(['temperature', 'topP', 'topK', 'maxOutputTokens']
          .filter((key) => typeof output[key] === 'number' && Number.isFinite(output[key])).map((key) => [key, output[key]])) });
    },
    async 'chat.headers'(event, output) {
      await call('chat.headers', [event, output]);
      output.headers[correlation] = event.sessionID;
    },
    async 'permission.ask'(event, output) {
      await call('permission.ask', [event, output]);
      if (output.status === 'deny') { budget.stop('permission_denied'); throw new CanaryBlocked('permission_denied'); }
    },
    async 'experimental.text.complete'(event, output) {
      await call('experimental.text.complete', [event, output]);
      const stage = extractions.get(event.sessionID);
      if (stage?.calls === 1 && stage.injection) {
        if (stage.injected) throw new CanaryBlocked('multiple_extraction_text_parts');
        stage.injected = true;
        output.text = stage.injection;
        budget.event({ kind: 'candidate.injected', session: event.sessionID, message: event.messageID,
          part: event.partID, root: stage.root, slot: budget.snapshot().sessions[event.sessionID].slot,
          native_completion_fabricated: false, replaces: 'first_stage_text', candidate_hash: digest(stage.injection) });
      }
    },
    async event(event) {
      const actual = event.event;
      const info = actual.properties?.info;
      const part = actual.properties?.part;
      if (actual.type === 'permission.replied' && actual.properties.response === 'reject') budget.stop('permission_denied');
      if (['session.status', 'session.deleted', 'session.error', 'permission.updated', 'permission.replied'].includes(actual.type) ||
          actual.type === 'message.updated' && (info.role === 'user' || info.finish) ||
          actual.type === 'message.part.updated' && ['completed', 'error'].includes(part.state?.status)) {
        budget.event({ kind: 'native.event', type: actual.type, session: info?.sessionID ?? part?.sessionID ??
        actual.properties?.sessionID ?? null, message: info?.id ?? part?.messageID ?? null,
        parent: info?.parentID ?? null, finish: info?.finish ?? null, tool: part?.tool ?? null,
        part: part?.id ?? null, call: part?.callID ?? null, status: part?.state?.status ?? null,
        usage: info?.role === 'assistant' && info.finish ? usage(info) : null });
      }
      await call('event', [event]);
    },
    async dispose() { try { await call('dispose', []); } finally { fetchTarget.fetch = originalFetch; } },
  };
}

module.exports = { createFixture };
