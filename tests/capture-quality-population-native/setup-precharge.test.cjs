const assert = require('node:assert/strict');
const test = require('node:test');
const { nativeRuntime } = require('./native-runtime.cjs');
const { preparePermissions } = require('./permission-configuration.cjs');
const { install } = require('./plugin-runtime.cjs');
const { productionProbe } = require('./production-probe.cjs');
const { sources } = require('./authorization.cjs');
const { caseLimits, inventory } = require('./inventory.cjs');
const { runCase } = require('./adapter.cjs');
const { resolveCase } = require('../capture-quality-population/inputs.cjs');
const { hash, requireStage } = require('./value.cjs');
const origin = `repository:${'d'.repeat(64)}`;
const database = '/synthetic/precharge/memory.db';

async function harness(id, overrides = {}, failure) {
  const limits = { ...caseLimits(id), ...overrides }; const used = {};
  let forwardCharge;
  const calls = []; const spawns = []; const stored = new Map();
  const charge = (key, amount = 1) => {
    requireStage((used[key] ?? 0) + amount <= limits[key], `budget_${key}`);
    forwardCharge?.(key, amount);
    used[key] = (used[key] ?? 0) + amount;
  };
  const native = await nativeRuntime({ paths: { project: '/synthetic/precharge/project', database },
    native: { path: '/inert/native' }, node: { path: '/inert/node' }, environment: {} }, charge,
  { bridge: { async run(argv, options) {
    calls.push(argv[0]); options.beforeSpawn(); spawns.push(argv[0]);
    if (argv[0] === 'scope') return { receipt: { targets: [{ repository_id: origin }] } };
    if (argv[0] === 'status') return { receipt: {} };
    if (argv[0] === 'remember') {
      if (failure === 'remember') throw new Error('response_lost');
      const id = stored.size + 731; stored.set(id, { id, placement: origin, content: argv.at(-1) });
      return { receipt: { status: 'inserted', operation_id: `write-${id}`, returned_ids: [id] } };
    }
    if (argv[0] === 'read') {
      if (failure === 'read') throw new Error('read_failed');
      return { receipt: { operation_id: `read-${argv[1]}`, operation: 'read', status: 'ok', truncated: false,
        results: [{ memory: stored.get(Number(argv[1])) }] } };
    }
    assert.deepEqual(argv, ['organize', 'read']);
    return { receipt: { organization: { records: [{ snapshot: stored.get(JSON.parse(options.stdin).keys[0].id) }] } } };
  } } });
  return { native, charge, used, calls, spawns, stored, bindCharge(callback) { forwardCharge = callback; } };
}

async function configured(id, current) {
  const probe = await productionProbe(); const observations = []; const commands = [];
  const hooks = await install({ directory: '/synthetic/precharge/project', client: { session: {} },
    serverUrl: new URL('http://127.0.0.1:4444') }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: sources().digest, approval_id: 'offline-only',
    socket: '/synthetic/socket', token: 'offline-only', privateRoot: '/synthetic/precharge',
    paths: { database }, endpoints: [], case: id,
  }, { native: current.native, fetch: async () => { throw new Error('network_forbidden'); },
    fixture: (input, seam) => require('./fixture.cjs').createFixture(input, { ...seam, factory: probe.factory }),
    rpc: async (route, body) => {
      if (route === '/next') return commands.shift() ?? { method: 'stop' };
      observations.push({ route, body }); return {};
    } });
  return { hooks, observations, commands, defaults: probe.defaults,
    config: () => hooks.config({ provider: { 'openai-b1': { options: {} } } }) };
}

for (const dimension of ['setup_writes', 'seed_calls']) {
  test(`native setup refuses ${dimension}=0 before remember bridge entry or beforeSpawn`, async () => {
    const current = await harness('verified-retirement', { [dimension]: 0 });
    await assert.rejects(preparePermissions('verified-retirement', current.native, database), { code: `budget_${dimension}` });
    assert.deepEqual(current.calls, ['scope', 'status']); assert.deepEqual(current.spawns, ['scope', 'status']);
    assert.equal(current.stored.size, 0); assert.equal(current.native.uncertain(), false);
  });

  test(`plugin config refuses ${dimension}=0 before any remember while host open is pending`, async () => {
    const current = await harness('verified-retirement', { [dimension]: 0 });
    const plugin = await configured('verified-retirement', current);
    try {
      await assert.rejects(plugin.config(), { code: `budget_${dimension}` });
      assert.deepEqual(current.calls, ['scope', 'status']); assert.equal(current.stored.size, 0);
      assert.deepEqual(plugin.defaults, []);
    } finally { await plugin.hooks.dispose(); }
  });

  test(`second seed exhausts ${dimension} before a second remember and retains first consumption`, async () => {
    const current = await harness('verified-retirement', { [dimension]: 1 });
    await assert.rejects(preparePermissions('verified-retirement', current.native, database), { code: `budget_${dimension}` });
    assert.equal(current.calls.filter((command) => command === 'remember').length, 1);
    assert.equal(current.spawns.filter((command) => command === 'remember').length, 1);
    assert.equal(current.used[dimension], 1); assert.equal(current.stored.size, 1);
  });
}

test('normal setup charges both logical dimensions once and cached seed consumption never replays or recharges', async () => {
  const current = await harness('verified-retirement');
  const setup = await preparePermissions('verified-retirement', current.native, database);
  const used = structuredClone(current.used); const calls = [...current.calls];
  const { original } = resolveCase('verified-retirement');
  for (const record of [original.record, ...original.participants]) {
    assert.equal(setup.seed({ content: record.body, placement: origin }).content, record.body);
  }
  assert.throws(() => setup.seed({ content: original.record.body, placement: origin }), { code: 'seed_setup_mismatch' });
  assert.equal(current.used.setup_writes, 2); assert.equal(current.used.seed_calls, 2);
  assert.deepEqual(current.used, used); assert.deepEqual(current.calls, calls);
});

test('config, repeated config and serialized cached seed commands share exact-once native setup', async () => {
  const current = await harness('verified-retirement'); const plugin = await configured('verified-retirement', current);
  try {
    await plugin.config(); await plugin.config();
    const used = structuredClone(current.used); const calls = [...current.calls];
    const { original } = resolveCase('verified-retirement');
    plugin.commands.push({ id: 1, method: 'initialize' }, ...[original.record, ...original.participants].map((record, index) =>
      ({ id: index + 2, method: 'seed', value: { content: record.body, placement: origin } })),
    { id: 4, method: 'seed', value: { content: original.record.body, placement: origin } });
    await plugin.hooks.qualityPump();
    const results = plugin.observations.filter(({ route }) => route === '/result').map(({ body }) => body);
    assert.equal(results[0].value.origin, origin);
    assert.deepEqual(results.slice(1, 3).map(({ value }) => value.id), [731, 732]);
    assert.equal(results[3].error, 'seed_setup_mismatch');
    assert.equal(current.used.setup_writes, 2); assert.equal(current.used.seed_calls, 2);
    assert.deepEqual(current.used, used); assert.deepEqual(current.calls, calls); assert.deepEqual(plugin.defaults, []);
  } finally { await plugin.hooks.dispose(); }
});

for (const failure of ['remember', 'read']) {
  test(`partial setup ${failure} failure keeps logical budget consumed without automatic retry`, async () => {
    const current = await harness('verified-condition-update', {}, failure);
    await assert.rejects(preparePermissions('verified-condition-update', current.native, database),
      { message: failure === 'remember' ? 'response_lost' : 'read_failed' });
    assert.equal(current.used.setup_writes, 1); assert.equal(current.used.seed_calls, 1);
    assert.equal(current.calls.filter((command) => command === 'remember').length, 1);
    assert.equal(current.native.uncertain(), failure === 'remember');
    if (failure === 'remember') {
      const calls = [...current.calls];
      await assert.rejects(current.native.invoke(['remember']), { code: 'unknown_write_no_retry' });
      await assert.rejects(current.native.invoke(['organize', 'maintain']), { code: 'unknown_write_no_retry' });
      assert.deepEqual(current.calls, calls);
    }
  });
}

test('adapter does not double-charge native setup completed inside open and cached receipts remain consumable', async () => {
  const id = 'verified-retirement'; const current = await harness(id);
  const needed = inventory(); const budget = { mode: 'native', approved: true, approval_id: 'in-memory-offline-test-only',
    population_sha256: needed.tuning_sha256, inventory_sha256: hash(needed), limits: needed.limits };
  let setup; let delivered = false;
  const host = { mode: 'native', async open(request) {
    current.bindCharge(request.charge);
    setup = await preparePermissions(id, current.native, database);
    return { sessionID: 'offline-root', origin, root: '/synthetic/precharge/project', node: '/inert/node', version: '1.19.3' };
  }, seed: (snapshot) => setup.seed(snapshot), async deliver() { delivered = true; throw new Error('stop_before_semantics'); },
  async close() { return { exited: true, children: 0, removed: false }; } };
  const result = await runCase(id, { host, budget });
  assert.equal(delivered, true); assert.equal(result.reason, 'host_boundary_failed');
  assert.deepEqual(result.setup_attempts.map(({ status }) => status), ['verified', 'verified']);
  assert.equal(result.budget_used.setup_writes, 2); assert.equal(result.budget_used.seed_calls, 2);
  assert.equal(current.stored.size, 2); assert.equal(result.quality_credit, false);
});
