const assert = require('node:assert/strict');
const test = require('node:test');
const { control, wire } = require('./control.cjs');
const { install } = require('./plugin-runtime.cjs');
const { createFixture } = require('./fixture.cjs');
const { sources } = require('./authorization.cjs');
const { inventory, caseLimits } = require('./inventory.cjs');
const { selection, endpoint, memoryHTTP, upstream } = require('./selected-provider-fixture.cjs');
const profile = 'controlled_native_parent_genuine_curator_v1';
const origin = `repository:${'b'.repeat(64)}`;

async function harness(packet = {}, limits = {}, production = {}) {
  const used = {}; const observed = []; const remote = upstream(); const channel = control('inert'); const binding = selection(); let client; let serial = 0;
  const caseID = packet.memories ? 'verified-condition-update' : 'same-task-third-turn';
  const { createOpencodeClient } = await import('@opencode-ai/sdk');
  const config = { provider: { 'openai-b1': { options: {} } } };
  const sdk = createOpencodeClient({ baseUrl: 'http://inert.invalid', fetch: async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/config') return Response.json(config);
    if (pathname === '/agent') return Response.json([{ name: 'build', mode: 'primary', permission: [{ permission: '*', pattern: '*', action: 'allow' }] }]);
    if (request.method === 'GET' && pathname.startsWith('/session/')) return Response.json({ id: pathname.split('/').at(-1), permission: [], directory: '/synthetic/project' });
    if (request.method === 'POST' && new URL(request.url).pathname === '/session') {
      const body = await request.json(); return Response.json({ id: body.parentID ? `child-${++serial}` : 'root' });
    }
    return Response.json(true);
  } });
  const root = (await sdk.session.create({ body: {} })).data.id;
  channel.bind({ charge(key, amount = 1) {
    const cap = limits[key] ?? inventory().limits[key] ?? (key.endsWith('_bytes') ? 99 * 262144 : 99);
    assert.ok((used[key] ?? 0) + amount <= cap, `global_${key}`); used[key] = (used[key] ?? 0) + amount;
  }, user() {}, tool() {}, complete() {}, record: (event) => observed.push(event) });
  channel.bindProvider({ binding, limits: caseLimits(caseID), session: (id) => id === root, send: remote.send });
  const hooks = await install({ client: sdk, directory: '/synthetic/project', worktree: '/synthetic/project', serverUrl: new URL('http://inert.invalid') }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: sources().digest, approval_id: 'offline-selection-only',
    socket: '/inert/socket', token: 'inert', privateRoot: '/inert', paths: { database: '/inert/db' },
    case: caseID, endpoints: [endpoint], network_binding: binding, execution_profile: profile,
  }, { rpc: wire('/inert/socket', 'inert', memoryHTTP(channel.handler)), providerSend: memoryHTTP(channel.handler),
    fetch: async () => { throw new Error('unexpected_local_fetch'); },
    native: { initialize: async () => origin, seed: async (record) => ({ ...record, id: 71, readback: { ...record, id: 71 } }),
      invoke: production.invoke ?? (() => { throw new Error('unexpected_native'); }), uncertain: () => false },
    fixture: (input, seam) => createFixture(input, { ...seam, factory: async (input, options) => {
      client = input.client; return production.factory ? production.factory(input, options) : { dispose() {} };
    } }) });
  await hooks.config(config);
  const pumping = hooks.qualityPump(); await channel.ready;
  const bound = { root, user: 'Inspect supplied evidence.', operations: [], review: true, ...packet };
  await channel.call('bind', bound);
  await hooks['chat.message']({ sessionID: root, agent: 'build', model: { providerID: 'openai-b1', modelID: 'gpt-6.1-sol' } },
    { message: { id: 'user', role: 'user', agent: 'build' }, parts: [{ id: 'user-text', type: 'text', text: bound.user }] });
  async function send(input = [], owner = root) {
    const output = { headers: {} }; await hooks['chat.headers']({ sessionID: owner }, output);
    return config.provider['openai-b1'].options.fetch(endpoint, { method: 'POST', headers: output.headers,
      body: JSON.stringify({ model: 'gpt-6.1-sol', stream: true, input, tools: ['read', 'bash', 'memocap_read', 'memocap_maintain', 'memocap_recall']
        .map((name) => ({ type: 'function', name, parameters: { type: 'object' } })) }) });
  }
  return { hooks, client, send, used, remote, channel, bound, observed,
    params: (sessionID = root) => hooks['chat.params']({ sessionID }, {}),
    close: async () => { await channel.call('close', { session: root }); await pumping; channel.stop(); } };
}
const frames = async (response) => (await response.text()).trim().split('\n\n').map((line) => JSON.parse(line.slice(6)));
const callOf = (events) => events.find((event) => event.type === 'response.output_item.done').item;
async function terminal(current, call, output = '{}', status = 'completed') {
  const message = { id: `msg-${call.call_id}`, role: 'assistant', sessionID: 'root', parentID: 'user' };
  await current.hooks.event({ event: { type: 'message.updated', properties: { info: message } } });
  await current.hooks['tool.execute.before']({ sessionID: 'root', tool: call.name, callID: call.call_id }, { args: JSON.parse(call.arguments) });
  if (current.hooks.tool?.[call.name]) {
    const result = await current.hooks.tool[call.name].execute(JSON.parse(call.arguments), {
      sessionID: 'root', messageID: message.id, agent: 'build', abort: new AbortController().signal, ask: async () => {}, metadata() {} });
    output = typeof result === 'string' ? result : result.output;
  }
  await current.hooks.event({ event: { type: 'message.part.updated', properties: { part: {
    id: `part-${call.call_id}`, type: 'tool', sessionID: 'root', messageID: message.id, callID: call.call_id, tool: call.name,
    state: { status, input: JSON.parse(call.arguments), ...(status === 'error' ? { error: output } : { output }), time: { start: 1, end: 2 } },
  } } } });
  return [{ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
    { type: 'function_call_output', call_id: call.call_id, output }];
}

test('controlled root emits complete text lifecycle locally after its generation reservation', async () => {
  const current = await harness();
  try {
    await current.params(); const response = await current.send();
    assert.equal(current.remote.calls.length, 0, 'controlled root must be answered before genuine egress');
    const result = await frames(response);
    assert.deepEqual(result.map(({ type }) => type), ['response.created', 'response.output_item.added',
      'response.output_text.delta', 'response.output_item.done', 'response.completed']);
    assert.equal(current.used.scripted_root_generations, 1); assert.equal(current.used.scripted_root_dispatches, 1);
    assert.equal(current.used.requests ?? 0, 0); assert.ok(current.used.scripted_root_response_bytes > 0);
  } finally { await current.close(); }
});

test('root memory sequence refuses continuation before an actual full read terminal', async () => {
  const current = await harness({ memories: [{ id: 71, placement: origin, role: 'primary', access: 'read', declaration: 'use' },
    { id: 99, placement: origin, role: 'comparison', access: 'read' }] });
  try {
    await current.params(); const first = callOf(await frames(await current.send()));
    assert.equal(first.name, 'memocap_read'); assert.deepEqual(JSON.parse(first.arguments), { id: 71, placement: origin });
    await current.params(); await assert.rejects(current.send(), /controlled_terminal_missing/);
  } finally { await current.close(); }
});
test('maintenance use comes from actual terminal read output with unchanged full-body quote', async () => {
  const { hash } = require('./value.cjs'); const content = 'When alpha is approved, retain the beta restriction.';
  const { productionProbe } = require('./production-probe.cjs'); const probe = await productionProbe();
  (await probe.load('node:fs')).setExport('realpathSync', (value) => value);
  const { receipt, organizationReceipt, organizationSnapshot } = require('../plugin-fixture.cjs');
  const record = { ...organizationSnapshot(71, content), placement: origin, scope: 'repository' }; const calls = [];
  const current = await harness({ memories: [{ id: 71, placement: origin, role: 'primary', access: 'read', declaration: 'use' },
    { id: 99, placement: origin, role: 'comparison', access: 'read' }] }, {}, {
    factory: probe.factory, async invoke(argv, options) {
      calls.push(argv);
      if (argv[0] === 'organize') return { receipt: organizationReceipt('read', { database: '/synthetic/memory.db',
        records: JSON.parse(options.stdin).keys.map((key) => ({ ...key, snapshot: { ...record, id: key.id } })) }) };
      return { receipt: receipt(argv[0] === 'scope' ? 'scope_resolve' : argv[0], { results: argv[0] === 'read' ? [{ memory: { ...record, id: Number(argv[1]) },
        source_order: 0, visibility: 'visible', applicability: 'unknown', applicable_repositories: [] }] : [],
        targets: [{ canonical_path: '/synthetic/project', repository_id: origin, identity_source: 'directory', placements: [origin],
          descriptor: null, observed_at: null }], returned_ids: argv[0] === 'read' ? [Number(argv[1])] : [] }) };
    } });
  try {
    await current.params(); const read = callOf(await frames(await current.send()));
    const history = await terminal(current, read);
    const receipt = JSON.parse(history[1].output); assert.ok(receipt.maintenance_read);
    await current.params(); const comparison = callOf(await frames(await current.send(history)));
    assert.deepEqual(JSON.parse(comparison.arguments), { id: 99, placement: origin }); history.push(...await terminal(current, comparison));
    await current.params(); const use = callOf(await frames(await current.send(history)));
    assert.equal(use.name, 'memocap_maintain');
    assert.deepEqual(JSON.parse(use.arguments), { operation: 'use', ...receipt.maintenance_read, statements: [content] });
    history.push(...await terminal(current, use)); assert.equal(JSON.parse(history.at(-1).output).status, 'used');
    await current.params(); const done = await frames(await current.send(history));
    assert.equal(done[1].item.type, 'message'); assert.equal(current.remote.calls.length, 0);
    assert.equal(receipt.maintenance_read.content_hash, hash(content)); assert.ok(calls.filter((argv) => argv[0] === 'organize').length >= 2);
    assert.deepEqual(probe.defaults, []);
  } finally { await current.close(); }
});
for (const owner of ['unknown', 'forged-child']) test(`unknown owner ${owner} fails before network or reservation`, async () => {
  const current = await harness();
  try {
    await assert.rejects(current.params(owner), /controlled_owner/);
    await assert.rejects(current.send([], owner), /controlled_owner/);
    assert.equal(current.remote.calls.length, 0); assert.equal(current.used.requests ?? 0, 0);
  } finally { await current.close(); }
});
test('SDK child keeps genuine transport and generation four refusal preserves confirmed write and readback', async () => {
  const { receipt, memory } = require('../plugin-fixture.cjs'); let writes = 0;
  const current = await harness({}, {}, { async invoke(argv, options) {
    if (argv[0] === 'remember') { options.beforeSpawn(); writes++; }
    return { receipt: receipt(argv[0], { operation_id: `00000000-0000-0000-0000-00000000031${argv[0] === 'read' ? '2' : '1'}`,
      status: argv[0] === 'read' ? 'ok' : 'inserted', truncated: false, caller: { actor: 'plugin', session_id: 'child-1', message_id: 'write' },
      results: [memory()], returned_ids: [1], searched_placements: [memory().memory.placement] }) };
  }, factory: async (_input, options) => ({ dispose() {}, tool: { memocap_remember: { async execute(_args, context) {
    await context.ask({ permission: 'memocap_remember' });
    const result = await options.invoke(['remember', '--caller-json', JSON.stringify({ session_id: context.sessionID, message_id: context.messageID })], { beforeSpawn() {} });
    await options.invoke(['read'], {}); return JSON.stringify(result.receipt);
  } } } }) });
  try {
    const child = (await current.client.session.create({ body: { parentID: 'root', title: 'memocap capture extract' } })).data.id;
    for (let index = 0; index < 3; index++) {
      await current.params(child); assert.equal(current.used.worker_requests, index + 1);
      assert.equal(await (await current.send([], child)).text(), 'data: ok\n\n');
    }
    await current.hooks.tool.memocap_remember.execute({}, { sessionID: child, messageID: 'write', ask: async () => {} });
    await assert.rejects(current.params(child), /review_generation_budget/); await current.channel.call('initialize');
    const ledger = require('./ledger.cjs').createLedger({ charge() {} }); ledger.begin('root', 'user'); current.observed.forEach(ledger.record);
    assert.equal(writes, 1); assert.equal(ledger.snapshot().saved_outputs[0].verified, true);
    assert.equal(current.remote.calls.length, 3); assert.equal(current.used.provider_requests, 3);
    assert.ok(current.remote.calls.every(({ init }) => !Object.keys(init.headers).some((key) => key.startsWith('x-memocap-'))));
  } finally { await current.close(); }
});
test('stale SDK child and forged public root message cannot acquire current ownership', async () => {
  const current = await harness();
  try {
    const child = (await current.client.session.create({ body: { parentID: 'root', title: 'memocap capture extract' } })).data.id;
    await current.params(); await frames(await current.send());
    await current.channel.call('bind', { ...current.bound, user: 'Next task' });
    await assert.rejects(current.hooks['chat.message']({ sessionID: 'foreign' }, { message: { id: 'foreign-user' }, parts: [] }), /controlled_owner/);
    await current.hooks['chat.message']({ sessionID: 'root' }, { message: { id: 'next-user' }, parts: [] });
    await assert.rejects(current.params(child), /controlled_owner/); await assert.rejects(current.send([], child), /controlled_owner/);
    await assert.rejects(current.client.session.messages({ path: { id: child } }), /controlled_owner/);
    assert.equal(current.remote.calls.length, 0);
  } finally { await current.close(); }
});

test('global generation refusal happens before genuine transport even when local review has capacity', async () => {
  const current = await harness({}, { requests: 0 });
  try {
    const child = (await current.client.session.create({ body: { parentID: 'root', title: 'memocap capture extract' } })).data.id;
    await assert.rejects(current.params(child)); assert.equal(current.remote.calls.length, 0);
  } finally { await current.close(); }
});
test('recalled unused stays recall and a denied terminal ends access without retry', async () => {
  const current = await harness({ memories: [{ id: 71, placement: origin, role: 'primary', access: 'recall', recall_query: 'Alpha requires approval.' }] });
  try {
    await current.params(); const recall = callOf(await frames(await current.send())); assert.equal(recall.name, 'memocap_recall');
    const history = await terminal(current, recall, JSON.stringify({ status: 'blocked', error: { code: 'permission_denied' } }), 'error');
    await current.params(); const done = await frames(await current.send(history)); assert.equal(done[1].item.type, 'message');
    await assert.rejects(current.params(), /controlled_finished/); assert.equal(current.remote.calls.length, 0);
  } finally { await current.close(); }
});
for (const dimension of ['scripted_root_generations', 'scripted_root_dispatches', 'scripted_root_response_bytes', 'total_bytes'])
  test(`local root refuses exhausted ${dimension} before response exposure`, async () => {
    const limits = {}; const current = await harness({}, limits); limits[dimension] = 0;
    try {
      if (dimension === 'scripted_root_generations') await assert.rejects(current.params());
      else { await current.params(); await assert.rejects(current.send()); }
      await assert.rejects(current.send()); assert.equal(current.remote.calls.length, 0);
    } finally { delete limits[dimension]; await current.close(); }
  });
test('cancelled local response prevents any further generation or genuine dispatch', async () => {
  const current = await harness();
  try {
    await current.params(); const response = await current.send(); await response.body.cancel();
    await assert.rejects(current.params(), /controlled_cancelled/); assert.equal(current.remote.calls.length, 0);
  } finally { await current.close(); }
});
test('two source operations advance serially only through observed terminal custody', async () => {
  const operations = ['first', 'second'].map((token) => ({ token, tool: 'read', input: { filePath: `/synthetic/${token}` } }));
  const current = await harness({ operations }); const prepared = []; const observed = [];
  current.channel.bind({ charge(key, amount = 1) { current.used[key] = (current.used[key] ?? 0) + amount; }, user() {}, complete() {}, record() {},
    prepare(token) { prepared.push(token); return { token }; }, tool(value) { observed.push(value.part.callID); } }, async () => {});
  try {
    const history = [];
    for (const operation of operations) {
      await current.params(); const call = callOf(await frames(await current.send(history)));
      assert.equal(JSON.parse(call.arguments).filePath, operation.input.filePath); history.push(...await terminal(current, call, '<file>actual</file>'));
    }
    await current.params(); assert.equal((await frames(await current.send(history)))[1].item.type, 'message');
    assert.deepEqual(prepared, ['first', 'second']); assert.equal(observed.length, 2); assert.equal(current.remote.calls.length, 0);
  } finally { await current.close(); }
});
