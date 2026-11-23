const assert = require('node:assert/strict');
const test = require('node:test');
const { runCase } = require('./adapter.cjs');
const { fakeHost } = require('./fake-host.cjs');
const { nativeRuntime } = require('./native-runtime.cjs');
const { install } = require('./plugin-runtime.cjs');
const { TransportBlocked } = require('./value.cjs');
const { resolveCase } = require('../capture-quality-population/inputs.cjs');
const origin = `repository:${'d'.repeat(64)}`;

async function compose(id, options = {}) {
  const calls = []; const stored = new Map(); const commands = []; const results = [];
  let serial = 0; let seam; let final; let before; let envelope;
  const native = await nativeRuntime({ paths: { project: '/synthetic/project', database: '/synthetic/memory.db' },
    native: { path: '/inert/native' }, node: { path: '/inert/node' }, environment: {} },
  (key, count) => seam.charge(key, count), { bridge: { async run(argv, boundary) {
    calls.push([...argv]); boundary.beforeSpawn(); const operation_id = `composition-${++serial}`;
    if (argv[0] === 'scope') return { receipt: { targets: [{ repository_id: origin }] } };
    if (argv[0] === 'status') return { receipt: {} };
    if (argv[0] === 'remember') {
      const key = stored.size + 71;
      stored.set(key, { id: key, placement: origin, scope: origin, content: argv.at(-1), kind: 'context', tags: '', topic_key: '',
        created_at: 'seed', updated_at: 'seed', organized_at: null, provenance: null });
      return { receipt: { operation_id, status: 'inserted', returned_ids: [key] } };
    }
    if (argv[0] === 'read') return { receipt: { operation_id, operation: 'read', status: 'ok', truncated: false,
      results: [{ memory: stored.get(Number(argv[1])) }] } };
    assert.deepEqual(argv, ['organize', 'read']);
    const receipt = { operation_id, operation: 'organize_read', status: 'ok', truncated: false,
      organization: { records: JSON.parse(boundary.stdin).keys.map((key) => ({ ...key, snapshot: stored.get(key.id) ?? null })) } };
    if (before) {
      if (options.readFailure === 'failure') throw new Error('injected_read_failure');
      if (options.readFailure === 'truncated') receipt.truncated = true;
      if (options.readFailure === 'malformed') receipt.organization.records[0].snapshot = { id: 71, placement: origin, content: 'partial' };
      if (options.readFailure === 'reused') receipt.operation_id = envelope[0].receipts.organization.operation_id;
    }
    return { receipt };
  } } });
  const hooks = await install({ client: { session: {} }, serverUrl: new URL('http://inert.invalid') }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: require('./authorization.cjs').sources().digest,
    approval_id: 'injected-only', socket: '/synthetic/socket', token: 'injected-only', privateRoot: '/synthetic',
    paths: { database: '/synthetic/memory.db' }, endpoints: [], case: id,
  }, { native, fetch: async () => { throw new Error('network_forbidden'); },
    fixture: async (_, injected) => { seam = injected; return { bind() {}, state: () => ({ children: [] }), dispose() {} }; },
    rpc: async (route, value) => {
      if (route === '/next') return commands.shift() ?? { method: 'stop' };
      if (route === '/result') results.push(value);
      return {};
    } });
  async function call(method, value) {
    commands.push({ id: `${method}-${results.length}`, method, value }); await hooks.qualityPump();
    const result = results.at(-1);
    if (result.error) throw new TransportBlocked(result.error);
    return result.value;
  }
  await hooks.config({ provider: { 'openai-b1': { options: {} } } });
  const host = fakeHost({ async settle({ request, session, user }) {
    await call('bind', { root: session, review: true });
    seam.review({ parentID: session, user_id: user, workflow: 'capture' });
    envelope = structuredClone(request.seed_bindings);
    options.tamper?.(request.seed_bindings);
    if (options.deleted) stored.delete(71);
    before = calls.length;
    final = await call('wait', request);
    return final;
  } });
  const open = host.open;
  host.open = async () => ({ ...await open(), origin: (await call('initialize', {})).origin });
  host.seed = async (request) => {
    const seed = await call('seed', request); host.memory.push(seed);
    return options.seedExtra ? { ...seed, unexpected_native_fact: true } : seed;
  };
  try {
    const report = await runCase(id, { host, budget: { mode: 'offline', approved: false } });
    return { report, final, envelope, calls, final_calls: calls.slice(before), stats: host.stats };
  } finally { await hooks.dispose(); }
}

for (const id of ['verified-condition-update', 'merge-unique-conditions', 'verified-retirement']) {
  test(`public runCase settles original ${id} through strict plugin binding and independent read`, async () => {
    const { original } = resolveCase(id);
    const originals = [original.record, ...(original.participants ?? [])];
    const current = await compose(id);
    assert.equal(current.report.status, 'wired', current.report.reason);
    assert.deepEqual(current.final.final_seed_state.records.map(({ snapshot }) => snapshot.content), originals.map(({ body }) => body));
    assert.deepEqual(current.final_calls, [['organize', 'read']]);
    assert.equal(current.calls.filter(([command]) => command === 'remember').length, originals.length);
    assert.equal(current.final.resources.native_reads, originals.length * 2 + 1);
    assert.equal(current.final.resources.setup_writes, originals.length);
    assert.equal(current.final.final_seed_state.receipt.operation_id.startsWith('composition-'), true);
    for (const [index, seed] of current.report.seeds.entries()) {
      assert.equal(seed.logical, originals[index].key);
      assert.equal(seed.logical_placement, originals[index].placement);
      assert.equal(seed.setup_only, true);
      assert.equal(Object.keys(seed).length, 9);
      assert.deepEqual(current.envelope[index], { id: seed.id, placement: seed.placement, content: seed.content,
        snapshot: seed.snapshot, readback: seed.readback, receipts: seed.receipts });
      for (const receipt of Object.values(seed.receipts)) assert.notEqual(current.final.final_seed_state.receipt.operation_id, receipt.operation_id);
    }
    assert.deepEqual([current.stats.native_processes, current.stats.provider_requests, current.stats.writes], [0, 0, 0]);
  });
}
test('public composition preserves independent deleted-null and surviving replacement state', async () => {
  const current = await compose('verified-retirement', { deleted: true });
  assert.equal(current.report.status, 'wired', current.report.reason);
  assert.deepEqual(current.final_calls, [['organize', 'read']]);
  assert.deepEqual(current.final.final_seed_state.records.map(({ snapshot }) => snapshot?.content ?? null),
    [null, resolveCase('verified-retirement').original.participants[0].body]);
  assert.equal(current.final.resources.setup_writes, 2);
});

const tampers = {
  missing: (bindings) => bindings.pop(),
  foreign: (bindings) => { bindings[0].placement = 'universal'; },
  duplicate: (bindings) => { bindings[1] = structuredClone(bindings[0]); },
  content: (bindings) => { bindings[0].content = 'forged'; },
  snapshot: (bindings) => { bindings[0].snapshot.content = 'forged'; },
  readback: (bindings) => { bindings[0].readback.content = 'forged'; },
  receipts: (bindings) => { bindings[0].receipts.write.operation_id = 'forged'; },
  unknown_extra: (bindings) => { bindings[0].unexpected_native_fact = true; },
};
for (const [name, tamper] of Object.entries(tampers)) test(`public envelope rejects ${name} before final read`, async () => {
  const current = await compose('verified-retirement', { tamper });
  assert.equal(current.report.reason, 'final_seed_binding_mismatch');
  assert.deepEqual(current.final_calls, []);
  assert.equal(current.calls.filter(([command]) => command === 'remember').length, 2);
});
test('unknown native field from seed producer survives adapter projection and fails strict binding', async () => {
  const current = await compose('verified-condition-update', { seedExtra: true });
  assert.equal(current.envelope[0].unexpected_native_fact, true);
  assert.equal(current.report.reason, 'final_seed_binding_mismatch');
  assert.deepEqual(current.final_calls, []);
});
for (const [readFailure, reason] of [['failure', 'plugin_operation_failed'], ['truncated', 'final_seed_read_unknown'],
  ['malformed', 'invalid_request'], ['reused', 'final_seed_read_unknown']]) test(`public composition keeps ${readFailure} final read terminal without replay`, async () => {
  const current = await compose('verified-condition-update', { readFailure });
  assert.equal(current.report.status, 'blocked');
  assert.equal(current.report.reason, reason);
  assert.deepEqual(current.final_calls, [['organize', 'read']]);
  assert.equal(current.calls.filter(([command]) => command === 'remember').length, 1);
});
module.exports = { compose };
