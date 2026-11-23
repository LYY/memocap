const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { hash, snapshot } = require('./maintenance-fixture.cjs');
const { organizationReceipt } = require('./plugin-fixture.cjs');

async function driver(options = {}) {
  const { createMaintenance } = await import('../plugin/maintenance/runtime.js');
  const database = __filename;
  mock.property(process, 'env', { MEMOCAP_DB: database });
  const events = [];
  const requests = [];
  const records = [snapshot(7, 'old route')];
  const writes = [];
  const readbacks = [];
  const asks = [];
  let applying;
  const sessions = new Map();
  const config = { permission: { memocap_maintain: options.deny ? 'deny' : {} } };
  const runtime = { configuredCwd: __dirname, warnings: [],
    context: async () => ({ directory: __dirname }), selected: async () => [],
    readPermission: { authorize: async () => {}, check: async () => {} }, invalidateCache() {} };
  if (options.commit) {
    const { maintenancePattern } = await import('../plugin/maintenance/permission.js');
    config.permission.memocap_maintain = { [maintenancePattern({ database, operation: 'update', id: 7, placement: 'universal' })]: 'allow' };
  }
  const client = {
    config: { get: async () => ({ data: config }) },
    app: { agents: async () => ({ data: [{ name: 'build', permission: [] }] }) },
    tool: { ids: async () => ({ data: ['memocap_maintain'] }) },
    session: {
      get: async ({ path }) => ({ data: sessions.get(path.id) ?? { id: path.id, permission: [] } }),
      create: async ({ body }) => {
        const id = `child-${sessions.size}`;
        sessions.set(id, { id, ...body });
        return { data: sessions.get(id) };
      },
      abort: async () => ({ data: true }), delete: async ({ path }) => ({ data: sessions.delete(path.id) }),
      messages: async () => ({ data: [{ info: { id: 'commit-message' }, parts: [{ type: 'tool', tool: 'memocap_maintain', callID: 'apply',
        state: { status: 'running', input: applying } }] }] }),
      prompt: async ({ path, body, signal }) => {
        maintenance.params({ sessionID: path.id }, {});
        const packet = JSON.parse(body.parts[0].text);
        requests.push(packet);
        await options.onPrompt?.({ packet, signal, maintenance });
        if (packet.stage === 'commit') {
          applying = { operation: 'apply', proposal_id: packet.proposal_id };
          maintenance.before({ sessionID: path.id, tool: 'memocap_maintain', callID: 'apply' });
          await maintenance.execute(applying, { sessionID: path.id, messageID: 'commit-message', abort: new AbortController().signal, ask: async (request) => {
            asks.push(request);
            if (options.nativeDeny) throw Object.assign(new Error('injected native refusal'), { code: 'permission_denied' });
          } });
          return { data: { info: { finish: 'stop' }, parts: [{ type: 'text', text: '{}' }] } };
        }
        const source = packet.evidence[0];
        const decision = { action: 'update', target: packet.used[0].use_id, content: 'new route',
          citations: [{ source_id: source.source_id, quote: 'Check current route' }] };
        const value = packet.stage === 'support' ? { ...packet.binding, status: options.support ?? 'supported' }
          : { decision: options.decision ? options.decision(decision, packet) : decision };
        const text = options.answer ? options.answer(value, packet) : JSON.stringify(value);
        return { data: { info: { finish: 'stop' }, parts: [{ type: 'text', text }] } };
      },
    },
  };
  let calls = 0;
  const maintenance = createMaintenance({ client, captureExecutionMs: options.captureExecutionMs,
    maintenanceExecutionMs: options.maintenanceExecutionMs, ...(options.disabled ? {} : { maintenanceObservation: async (event) => {
    events.push(event);
    await options.observer?.(event);
  } }) }, runtime, { invoke: async (argv, dispatch) => {
    assert.equal(argv[0], 'organize');
    if (argv[1] === 'maintain' && options.commit) {
      dispatch.beforeSpawn();
      const request = JSON.parse(dispatch.stdin);
      writes.push(request);
      records[0] = { ...records[0], content: request.group.content, organized_at: '2026-11-16T00:00:00Z' };
      await options.afterWrite?.({ maintenance, signal: dispatch.signal });
      return { receipt: organizationReceipt('maintain', { database, action: request.group.action, records: [records[0]], deleted: [] }, {
        status: 'ok', outcome: 'committed', activity_status: 'recorded',
        caller: { actor: 'plugin', session_id: [...sessions.keys()].at(-1), message_id: 'commit-message' },
      }) };
    }
    assert.equal(argv[1], 'read');
    calls++;
    if (writes.length) readbacks.push(structuredClone(records));
    return { receipt: organizationReceipt('read', { database, records: records.map((record) => ({
      id: record.id, placement: record.placement, snapshot: record })) }) };
  } });
  const context = { sessionID: 'parent', messageID: 'assistant', abort: new AbortController().signal };
  const args = { id: 7, placement: 'universal' };
  maintenance.observe({ sessionID: 'parent', agent: 'build' }, { message: { id: 'user', role: 'user',
    model: { providerID: 'offline', modelID: 'scripted' } },
    parts: [{ id: 'source', type: 'text', text: 'Check current route' }] });
  maintenance.before({ ...context, tool: 'memocap_read', callID: 'read' }, { args });
  const read = await maintenance.registerRead({ status: 'ok', backend: 'local', results: [{ completeness: 'full',
    memory: records[0], content_hash: hash(records[0].content) }] }, args, context);
  const declaration = { operation: 'use', ...read.maintenance_read, statements: ['old route'] };
  maintenance.before({ ...context, tool: 'memocap_maintain', callID: 'use' }, { args: declaration });
  assert.equal((await maintenance.execute(declaration, context)).status, 'used');
  maintenance.event({ event: { type: 'message.updated', properties: { info: { id: 'assistant', sessionID: 'parent',
    parentID: 'user', role: 'assistant', finish: 'stop', time: { completed: 42 } } } } });
  await options.ready?.(maintenance);
  const captureAllowed = await maintenance.coordinator.beforeReview({ parentID: 'parent', userID: 'user' });
  const repeated = await maintenance.coordinator.beforeReview({ parentID: 'parent', userID: 'user' });
  const summary = structuredClone(runtime.maintenanceStatus('parent'));
  await maintenance.dispose();
  mock.restoreAll();
  return { events, summary, requests, calls, records, writes, readbacks, asks, captureAllowed, repeated };
}

module.exports = { driver };
if (require.main === module) driver().then(({ events, summary, calls }) => {
  assert.deepEqual(events.filter((event) => event.phase === 'maintenance.decision').map((event) => event.stage),
    ['raw_proposal', 'validated_decision', 'support_assessment', 'issuance']);
  assert.equal(summary.reason, 'maintenance_grant_required');
  console.log(JSON.stringify({ surface: 'public createMaintenance', events, summary, adapter_reads: calls,
    native_database: false, provider_dispatches: 0 }));
}).catch((error) => { mock.restoreAll(); console.error(error); process.exitCode = 1; });
