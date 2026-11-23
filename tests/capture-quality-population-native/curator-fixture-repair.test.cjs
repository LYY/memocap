const assert = require('node:assert/strict');
const test = require('node:test');
const { controlledParent } = require('./controlled-parent.cjs');
const origin = `repository:${'d'.repeat(64)}`;
async function recall() {
  const charges = [];
  const parent = controlledParent({ charge: (...args) => charges.push(args), endpoints: ['https://inert.invalid/responses'], flush: async () => {} });
  parent.bind({ root: 'root', user: 'Neutral task', operations: [], memories: [
    { id: 71, placement: origin, access: 'recall', role: 'primary', recall_query: 'Alpha requires approval.' }] });
  parent.user('user'); parent.reserve();
  const response = await parent.respond({ method: 'POST', url: 'https://inert.invalid/responses', signal: new AbortController().signal,
    body: [Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', stream: true, input: [], tools: [{ type: 'function', name: 'memocap_recall' }] }))] });
  const frames = (await response.text()).trim().split('\n\n').map((frame) => JSON.parse(frame.slice(6)));
  const call = frames.find((frame) => frame.type === 'response.output_item.done').item;
  const args = JSON.parse(call.arguments);
  parent.before({ sessionID: 'root', callID: call.call_id, tool: call.name }, args);
  return { parent, charges, args, call, finish(output) { parent.terminal({ callID: call.call_id, sessionID: 'root', tool: call.name,
    state: { status: 'completed', input: args, output } }, { sessionID: 'root', parentID: 'user' }); } };
}
test('recall uses supplied seed query rather than neutral task', async () => {
  const current = await recall(); assert.equal(current.args.query, 'Alpha requires approval.');
});
for (const output of ['{', '{}', 'null', '{"status":"ok","returned_ids":[]}', '{"status":"ok","returned_ids":[99]}',
  '{"status":"ok","returned_ids":[71,"bad"]}', '{"status":"ok","returned_ids":[71],"truncated":true}']) {
  test(`invalid recall receipt stops before another reservation: ${output}`, async () => {
    const current = await recall(); assert.throws(() => current.finish(output));
    const before = current.charges.length;
    assert.throws(() => current.parent.reserve()); assert.equal(current.charges.length, before);
    assert.ok(current.parent.snapshot().stopped);
  });
}
test('valid recall leaves no adoption step', async () => {
  const current = await recall(); const output = '{"status":"ok","returned_ids":[71]}'; current.finish(output); current.parent.reserve();
  const response = await current.parent.respond({ method: 'POST', url: 'https://inert.invalid/responses', signal: new AbortController().signal,
    body: [Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', stream: true, input: [current.call,
      { type: 'function_call_output', call_id: current.call.call_id, output }], tools: [{ type: 'function', name: 'memocap_maintain' }] }))] });
  const frames = (await response.text()).trim().split('\n\n').map((frame) => JSON.parse(frame.slice(6)));
  assert.equal(frames.some((frame) => frame.item?.type === 'function_call'), false);
  assert.equal(current.parent.snapshot().finished, true);
});
async function seedHarness() {
  const calls = []; const charges = {}; const stored = new Map(); let serial = 0; let transform = (value) => value; let forward;
  const native = await require('./native-runtime.cjs').nativeRuntime({ paths: { project: '/synthetic/project', database: '/synthetic/memory.db' },
    native: { path: '/inert/native' }, node: { path: '/inert/node' }, environment: {} },
  (key, count = 1) => { forward?.(key, count); charges[key] = (charges[key] ?? 0) + count; }, { bridge: { async run(argv, options) {
    calls.push([...argv]); options.beforeSpawn(); const operation_id = `operation-${++serial}`;
    if (argv[0] === 'scope') return { receipt: { targets: [{ repository_id: origin }] } };
    if (argv[0] === 'status') return { receipt: {} };
    if (argv[0] === 'remember') {
      const id = stored.size + 71; stored.set(id, { id, placement: origin, content: argv.at(-1), scope: origin,
        kind: 'context', tags: '', topic_key: '', created_at: 'seed', updated_at: 'seed', organized_at: null, provenance: null });
      return { receipt: { operation_id, status: 'inserted', returned_ids: [id] } };
    }
    if (argv[0] === 'read') return { receipt: { operation_id, operation: 'read', status: 'ok', truncated: false,
      results: [{ memory: stored.get(Number(argv[1])) }] } };
    assert.deepEqual(argv, ['organize', 'read']);
    return { receipt: transform({ operation_id, operation: 'organize_read', status: 'ok', truncated: false,
      organization: { records: JSON.parse(options.stdin).keys.map((key) => ({ ...key, snapshot: stored.get(key.id) ?? null })) } }) };
  } } });
  await native.initialize();
  return { native, calls, charges, stored, corrupt(callback) { transform = callback; }, bindCharge(callback) { forward = callback; } };
}
test('final read independently includes deleted seed and unused replacement with metered original receipt', async () => {
  const current = await seedHarness();
  const seeds = await Promise.all(['old', 'replacement'].map((content) => current.native.seed({ content, placement: origin })));
  current.stored.delete(seeds[0].id); const before = structuredClone(current.charges);
  const result = await current.native.readSeedState(seeds.map(({ id, placement }) => ({ id, placement })));
  assert.deepEqual(result.records.map(({ snapshot }) => snapshot?.content ?? null), [null, 'replacement']);
  assert.deepEqual(result.receipt.organization.records, result.records);
  assert.ok(seeds.every((seed) => result.receipt.operation_id !== seed.receipts.organization.operation_id));
  assert.equal(current.charges.native_reads - before.native_reads, 1);
  assert.equal(current.charges.native_calls - before.native_calls, 1);
  assert.equal(current.charges.native_processes - before.native_processes, 2);
  assert.equal(current.charges.setup_writes, 2);
});
for (const invalid of ['foreign', 'unseeded', 'duplicate', 'too_many']) test(`final read rejects ${invalid} before dispatch`, async () => {
  const current = await seedHarness(); const seed = await current.native.seed({ content: 'old', placement: origin });
  const key = { id: seed.id, placement: origin };
  const keys = { foreign: [{ ...key, placement: 'universal' }], unseeded: [{ ...key, id: 99 }], duplicate: [key, key], too_many: [key, key, key, key] }[invalid];
  const before = current.calls.length;
  await assert.rejects(current.native.readSeedState(keys)); assert.equal(current.calls.length, before);
});
for (const invalid of ['truncated', 'missing', 'duplicate', 'wrong_id', 'missing_snapshot', 'partial_snapshot', 'operation_reuse', 'failure']) {
  test(`final read rejects ${invalid} result without replay or write`, async () => {
    const current = await seedHarness(); const seed = await current.native.seed({ content: 'old', placement: origin });
    current.corrupt((receipt) => {
      if (invalid === 'failure') throw new Error('injected_read_failure');
      if (invalid === 'truncated') receipt.truncated = true;
      if (invalid === 'missing') receipt.organization.records = [];
      if (invalid === 'duplicate') receipt.organization.records.push(receipt.organization.records[0]);
      if (invalid === 'wrong_id') receipt.organization.records[0].id = 99;
      if (invalid === 'missing_snapshot') delete receipt.organization.records[0].snapshot;
      if (invalid === 'partial_snapshot') receipt.organization.records[0].snapshot = { id: seed.id, placement: origin, content: 'partial' };
      if (invalid === 'operation_reuse') receipt.operation_id = seed.receipts.organization.operation_id;
      return receipt;
    });
    const before = current.calls.length;
    await assert.rejects(current.native.readSeedState([{ id: seed.id, placement: origin }]));
    assert.equal(current.calls.length, before + 1); assert.equal(current.charges.setup_writes, 1);
  });
}
async function settled(tamper) {
  const current = await seedHarness(); const commands = []; const results = []; let seam; const order = [];
  const hooks = await require('./plugin-runtime.cjs').install({ client: { session: {} }, serverUrl: new URL('http://inert.invalid') }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: require('./authorization.cjs').sources().digest,
    approval_id: 'injected-only', socket: '/synthetic/socket', token: 'injected-only', privateRoot: '/synthetic',
    paths: { database: '/synthetic/memory.db' }, endpoints: [], case: 'verified-retirement',
  }, { native: current.native, fetch: async () => { throw new Error('network_forbidden'); },
    fixture: async (_, injected) => { seam = injected; return { bind() {}, state: () => ({ children: [] }), dispose() {} }; },
    rpc: async (route, value) => {
      if (route === '/next') return commands.shift() ?? { method: 'stop' };
      if (route === '/result') { results.push(value); order.push(value.id); }
      return {};
    } });
  current.bindCharge(seam.charge);
  await hooks.config({ provider: { 'openai-b1': { options: {} } } });
  const seeds = [...current.stored.values()].map((memory) => ({ ...memory, snapshot: memory,
    readback: { ...memory, snapshot: memory } }));
  commands.push(...seeds.map((seed, index) => ({ id: index, method: 'seed', value: { content: seed.content, placement: origin } })));
  await hooks.qualityPump(); const bindings = results.map(({ value }) => value); results.length = 0;
  commands.push({ id: 'bind', method: 'bind', value: { root: 'root', review: true } }); await hooks.qualityPump();
  seam.review({ parentID: 'root', user_id: 'user', workflow: 'capture' });
  if (tamper === 'missing') bindings.pop();
  if (tamper === 'foreign') bindings[0].placement = 'universal';
  if (tamper === 'content') bindings[0].content = 'forged';
  if (tamper === 'duplicate') bindings[1] = bindings[0];
  const before = current.calls.length;
  commands.push({ id: 'wait', method: 'wait', value: { review: true, timeout_ms: 100, seed_bindings: bindings } });
  await hooks.qualityPump(); await hooks.dispose();
  return { result: results.at(-1), current, before, order };
}
test('plugin settle exposes every cached seed after terminal review through independent read', async () => {
  const { result, current, before } = await settled();
  assert.equal(result.error, undefined); assert.equal(result.value.final_seed_state.records.length, 2);
  assert.deepEqual(result.value.final_seed_state.records.map(({ id }) => id), [71, 72]);
  assert.equal(current.calls.length - before, 1); assert.equal(result.value.resources.native_reads, 5);
});
for (const tamper of ['missing', 'foreign', 'content', 'duplicate']) test(`plugin rejects ${tamper} cached seed binding before final read`, async () => {
  const { result, current, before } = await settled(tamper);
  assert.equal(result.error, 'final_seed_binding_mismatch'); assert.equal(current.calls.length, before);
});
test('negative tool visibility preserves production revision refusal', async () => {
  const { fixturePermissions } = require('./permission-configuration.cjs');
  const permissions = await fixturePermissions('changed-without-grant', { origin, root: '/private/project', worktree: '/private', database: '/private/db' }, []);
  const rules = permissions.root({ operations: [{ tool: 'read', input: { filePath: '/private/project/source' } }] });
  assert.equal(permissions.permission.memocap_maintain, 'ask');
  assert.deepEqual(rules.filter((rule) => rule.permission === 'memocap_maintain'), [{ permission: 'memocap_maintain', pattern: '*', action: 'ask' }]);
  const { maintenancePermissionSnapshot } = await import('../../plugin/maintenance/permission.js');
  for (const operation of ['update', 'delete', 'merge']) assert.equal(maintenancePermissionSnapshot({ config: { permission: permissions.permission },
    parent: rules, session: rules, agent: rules }, { database: '/private/db', operation,
    participants: (operation === 'merge' ? [71, 72] : [71]).map((id) => ({ id, placement: origin })) }).granted, false);
});
test('prepared wire seam uses existing metered native adapter with no external dispatch or mutation', async () => {
  const { wireNative } = require('./curator-fixture-wire.cjs'); const charges = {};
  const native = await wireNative({ paths: { project: '/synthetic/project', database: '/synthetic/db' } },
    (key, count = 1) => { charges[key] = (charges[key] ?? 0) + count; });
  const placement = await native.initialize(); const seed = await native.seed({ content: 'alpha', placement });
  const recalled = await native.invoke(['recall', 'alpha', '--placement', placement]);
  assert.deepEqual(recalled.receipt.returned_ids, [seed.id]);
  const { validateMemories } = await import('../../plugin/protocol.js');
  validateMemories(recalled.receipt, { kind: 'origins', placements: [placement] });
  assert.deepEqual((await native.invoke(['recall', 'unrelated'])).receipt.returned_ids, []);
  const state = await native.readSeedState([{ id: seed.id, placement }]);
  assert.equal(state.records[0].snapshot.content, 'alpha'); assert.equal(charges.native_reads, 3);
  const { validateOrganizationReceipt } = await import('../../plugin/organization-contract.js');
  validateOrganizationReceipt(state.receipt, { operation: 'read', database: '/synthetic/db', request: { keys: state.keys } });
  await assert.rejects(native.invoke(['organize', 'maintain']), /wire_mutation_forbidden/);
});
test('wire resolved targets pass public boundary while hashless seed read remains valid', async () => {
  const { wireNative } = require('./curator-fixture-wire.cjs');
  const { validateReceipt, validateRead } = await import('../../plugin/protocol.js');
  const { freezeTargets } = await import('../../plugin/targets.js');
  const native = await wireNative({ paths: { project: '/synthetic/project', database: '/synthetic/db' } }, () => {});
  const placement = await native.initialize(); const seed = await native.seed({ content: 'alpha', placement });
  assert.equal(seed.receipts.read.results[0].content_hash, undefined);
  assert.match(validateRead(seed.receipts.read, seed).results[0].content_hash, /^[a-f0-9]{64}$/);
  const receipt = validateReceipt((await native.invoke(['scope', 'resolve', '--repo', '/synthetic/project'])).receipt);
  assert.equal(freezeTargets(receipt)[0].repository_id, placement);
});
test('production read resolves wire context before exact read and subsequent recall', async () => {
  const { wireNative } = require('./curator-fixture-wire.cjs'); const charges = {};
  const { createRecallRuntime } = await import('../../plugin/recall.js');
  const { createOperations } = await import('../../plugin/operations.js');
  const rules = ['memocap_recall', 'memocap_read'].map((permission) => ({ permission, pattern: 'library', action: 'allow' }));
  const native = await wireNative({ paths: { project: '/synthetic/project', database: '/synthetic/db' } },
    (key, count = 1) => { charges[key] = (charges[key] ?? 0) + count; });
  const placement = await native.initialize(); const seed = await native.seed({ content: 'alpha', placement });
  const runtime = createRecallRuntime({ client: {
    session: { get: async () => ({ data: { directory: '/synthetic/project', agent: 'build', permission: rules } }) },
    app: { agents: async () => ({ data: [{ name: 'build', permission: rules }] }) },
  } }, {}, native.invoke);
  runtime.config({ permission: { memocap_recall: { library: 'allow' }, memocap_read: { library: 'allow' } } });
  const operations = createOperations(runtime); const context = { sessionID: 'root', messageID: 'user' };
  const receipt = await operations.read({ id: seed.id, placement }, context);
  assert.equal(receipt.results[0].memory.content, seed.content);
  const recalled = await operations.recall({ query: 'alpha', placements: [placement] }, context);
  assert.deepEqual(recalled.returned_ids, [seed.id]);
  assert.equal(new Set([seed.receipts.read.operation_id, receipt.operation_id, recalled.operation_id]).size, 3);
  const final = await native.readSeedState([{ id: seed.id, placement }]);
  assert.deepEqual(final.records[0].snapshot, seed.snapshot);
  assert.equal(charges.setup_writes, 1); assert.equal(charges.native_reads, 3);
});
for (const scenario of ['negative', 'recall', 'invalid']) test(`prepared ${scenario} packet binds original seed and private placement`, async () => {
  const { wireNative, wirePacket, scenarios } = require('./curator-fixture-wire.cjs');
  const native = await wireNative({ paths: { project: '/synthetic/project', database: '/synthetic/db' } }, () => {});
  const setup = await require('./permission-configuration.cjs').preparePermissions(scenarios[scenario], native, '/synthetic/db');
  const prepared = await wirePacket(scenario, { session: 'root', operation: { tool: 'read', input: { filePath: '/synthetic/project/source' } },
    async call(method, request) { return method === 'initialize' ? { origin: setup.origin } : setup.seed(request); } });
  assert.deepEqual(setup.seedKeys(prepared.seeds), prepared.packet.memories.map(({ id, placement }) => ({ id, placement })));
  if (scenario !== 'negative') assert.equal(prepared.packet.memories[0].recall_query, prepared.seeds[0].content);
  assert.equal(prepared.packet.review, false);
});
