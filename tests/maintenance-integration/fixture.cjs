const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture: baseFixture, receipt, organizationReceipt } = require('../plugin-fixture.cjs');
const { snapshot } = require('../maintenance-fixture.cjs');

async function fixture(context, options = {}) {
  const base = baseFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-seam-'));
  const database = path.join(fs.realpathSync(root), 'maintenance.db');
  fs.writeFileSync(database, 'mock adapter database identity');
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  context.mock.property(process, 'env', { ...process.env, MEMOCAP_DB: database,
    MEMOCAP_ADDR: '', MEMOCAP_URL: '', MEMOCAP_ADDRESS: '' });
  const records = [snapshot(7, 'old route')];
  const writes = [];
  const asks = [];
  const calls = [];
  const host = { modelDecision: () => null, support: 'supported', requests: [], supportBinding: (binding) => binding };
  base.input.client.config = { async get() { return { data: base.config }; } };
  base.input.client.tool = { async ids() { return { data: ['memocap_maintain', 'memocap_read', 'bash'] }; } };
  const sessions = new Map();
  base.input.client.session.create = async ({ body }) => {
    const id = `maintenance-child-${sessions.size}`;
    const session = { id, ...body, permission: body.permission ?? [] };
    sessions.set(id, session);
    return { data: session };
  };
  const getParent = base.input.client.session.get;
  base.input.client.session.get = async ({ path }) => sessions.has(path.id) ? { data: sessions.get(path.id) } : getParent({ path });
  base.input.client.session.abort = async () => ({ data: true });
  base.input.client.session.delete = async ({ path }) => ({ data: sessions.delete(path.id) });
  base.input.client.session.prompt = async ({ path, body }) => {
    maintenance.params({ sessionID: path.id }, {});
    host.requests.push({ path, body });
    const data = JSON.parse(body.parts[0].text);
    const text = JSON.stringify(data.stage === 'support' ? { ...host.supportBinding(data.binding), status: host.support,
      ...(data.continuity ? { continuity: host.continuitySupport ?? 'supported' } : {}) } : { decision: host.modelDecision(data),
      ...(data.prior ? { continuity: host.continuity?.(data) ?? { status: 'unknown' } } : {}) });
    return { data: { info: { finish: 'stop' }, parts: [{ type: 'text', text }] } };
  };
  const { createRecallRuntime } = await import('../../plugin/recall.js');
  const { createOperations } = await import('../../plugin/operations.js');
  const { createMaintenance } = await import('../../plugin/maintenance/runtime.js');
  const { createTools } = await import('../../plugin/tools.js');
  const invoke = async (argv, options) => {
    calls.push({ argv, options });
    if (argv[0] === 'organize') {
      if (argv[1] !== 'read') { writes.push(argv); assert.fail('unexpected write'); }
      const request = JSON.parse(options.stdin);
      return { receipt: organizationReceipt('read', { database, records: request.keys.map((key) => ({ ...key,
        snapshot: records.find((record) => record.id === key.id && record.placement === key.placement) ?? null })) }) };
    }
    if (argv[0] === 'read') { const record = records.find((entry) => entry.id === Number(argv[1]));
      return { receipt: receipt('read', { results: [{ memory: record, source_order: 0,
        visibility: 'source', applicable_repositories: [] }], returned_ids: [record.id] }) }; }
    return base.run(argv, options);
  };
  const runtime = createRecallRuntime(base.input, {}, invoke);
  runtime.config(base.config);
  const operations = createOperations(runtime);
  const maintenance = createMaintenance(base.input, runtime, { invoke, ...options });
  const tools = createTools(operations, undefined, maintenance);
  maintenance.config(base.config);
  const user = { message: { id: 'user-1', role: 'user', agent: 'build', model: { providerID: 'wire', modelID: 'wire-model' } },
    parts: [{ id: 'user-part', type: 'text', text: 'Check current route' }] };
  await runtime.capture({ sessionID: 'A', agent: 'build' }, user);
  maintenance.observe({ sessionID: 'A', agent: 'build' }, user);
  const toolContext = { sessionID: 'A', messageID: 'assistant-1', agent: 'build', abort: new AbortController().signal,
    metadata() {}, async ask(request) { asks.push(request); } };
  const execute = async (name, args) => {
    maintenance.before({ sessionID: toolContext.sessionID, messageID: toolContext.messageID, tool: name, callID: `call-${calls.length}` }, { args });
    return JSON.parse((await tools[name].execute(args, toolContext)).output);
  };
  context.after(async () => { await maintenance.dispose(); await runtime.dispose(); });
  Object.assign(host, { ...base, runtime, operations, maintenance, tools, records, writes, asks, calls, toolContext, execute,
    complete() {
      maintenance.event({ event: { type: 'message.updated', properties: { info: { id: 'assistant-1', sessionID: 'A', parentID: 'user-1', role: 'assistant', finish: 'stop', time: { completed: 42 } } } } });
    },
    read: (id = 7) => execute('memocap_read', { id, placement: 'universal' }),
    use: (read) => execute('memocap_maintain', { operation: 'use', ...read, statements: ['old route'] }) });
  return host;
}
module.exports = { fixture };
