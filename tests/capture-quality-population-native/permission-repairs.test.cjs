const assert = require('node:assert/strict');
const test = require('node:test');
const { lifecycleProbe } = require('./lifecycle-probe.cjs');
const { productionProbe } = require('./production-probe.cjs');
const { install } = require('./plugin-runtime.cjs');
const { sources } = require('./authorization.cjs');
const { resolveCase } = require('../capture-quality-population/inputs.cjs');
const origin = `repository:${'b'.repeat(64)}`;
const database = '/synthetic/private/memory.sqlite';

async function configuration(id) {
  const probe = lifecycleProbe({ id }); const location = await probe.open();
  const original = resolveCase(id).original;
  const seeds = [];
  for (const [index, record] of (original.record ? [original.record, ...(original.participants ?? [])] : []).entries()) {
    seeds.push({ logical: record.key, id: 941 + index * 17, placement: origin, content: record.body });
  }
  const writes = []; const calls = []; const rpc = [];
  const production = await productionProbe();
  const hooks = await install({ directory: '/synthetic/private/project', serverUrl: new URL('http://127.0.0.1:4444'), client: { session: {} } }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: sources().digest, approval_id: 'offline-only',
    socket: '/synthetic/socket', token: 'in-memory-only', privateRoot: '/synthetic/private',
    paths: { database }, endpoints: [], case: id,
  }, { rpc: async (route, value) => { rpc.push({ route, value });
    if (route === '/next') return { method: 'stop' }; return {};
  }, fetch: async () => { throw new Error('network_forbidden'); },
  native: { invoke: async () => { throw new Error('native_forbidden'); }, uncertain: () => false,
    initialize: async () => { calls.push('initialize'); return origin; },
    seed: async (request) => { writes.push(request); const seed = seeds[writes.length - 1];
      return { ...seed, readback: { ...seed } }; } },
  fixture: (input, seam) => require('./fixture.cjs').createFixture(input, { ...seam, factory: production.factory }) });
  const config = { ...probe.configs[0], provider: { 'openai-b1': { options: {} } } };
  await hooks.config(config);
  const packet = { user: 'Original task', operations: [], ...(original.record ? { memories: seeds.map(({ id, placement }) => ({ id, placement })) } : {}) };
  for (const seed of seeds) await probe.host.seed({ content: seed.content, placement: seed.placement });
  await probe.host.deliver(packet, { charge() {} }, { signal: new AbortController().signal });
  const rules = probe.rules.at(-1);
  const layers = { config: { permission: config.permission }, parent: rules, agent: rules, session: rules };
  return { probe, config, layers, seeds, hooks, calls, writes, rpc, location, original,
    async close() { await hooks.dispose(); await probe.host.close({}); } };
}

test('concrete positive read setup passes actual persistent and effective library evaluators', async () => {
  const current = await configuration('read-route');
  try {
    const { createReadPermission } = await import('../../plugin/read-permission.js');
    const gate = createReadPermission({ client: { session: { get: async () => ({ data: { permission: current.layers.parent, agent: 'build' } }) },
      app: { agents: async () => ({ data: [{ name: 'build', permission: current.layers.agent }] }) } } });
    gate.config(current.config);
    assert.equal(typeof await gate.check({ sessionID: 'actual-root' }, true), 'string');
    let observed;
    await assert.rejects(gate.authorize({ sessionID: 'actual-root', ask: async (request) => {
      observed = request; throw new Error('inert_native_ask_trap');
    } }, {}), { code: 'native_permission_denied' });
    assert.equal(observed.permission, 'memocap_recall'); assert.deepEqual(observed.patterns, ['library']);
  } finally { await current.close(); }
});

for (const [id, operation] of [['verified-condition-update', 'update'], ['verified-retirement', 'delete'],
  ['web-404', 'delete'], ['irrelevant-change', 'update'], ['recalled-unused', 'update'], ['snapshot-conflict', 'update'], ['lost-response', 'update']]) {
  test(`fixture authorization becomes an exact production maintenance grant only after actual seed IDs: ${id}`, async () => {
    const current = await configuration(id);
    try {
      const { maintenancePermissionSnapshot, createMaintenancePermissionGate, maintenancePattern } = await import('../../plugin/maintenance/permission.js');
      const target = { database, operation, participants: [{ id: current.seeds[0].id, placement: origin }] };
      const snapshot = maintenancePermissionSnapshot(current.layers, target);
      assert.equal(snapshot.granted, true); assert.equal(snapshot.action, 'allow');
      const expected = maintenancePattern({ database, operation, ...target.participants[0] });
      const gate = createMaintenancePermissionGate();
      const request = gate.issue({ proposal_id: 'offline-proposal', task: { parentID: 'root', taskID: 'task', epoch: 1 },
        target, permission_fingerprint: snapshot.fingerprint }, snapshot);
      assert.deepEqual(request.patterns, [expected]); gate.dispose();
      for (const changed of [{ database: '/foreign/db' }, { operation: operation === 'update' ? 'delete' : 'update' },
        { participants: [{ id: 942, placement: origin }] }, { participants: [{ id: 941, placement: 'universal' }] }]) {
        assert.equal(maintenancePermissionSnapshot(current.layers, { ...target, ...changed }).granted, false);
      }
      assert.equal(current.calls.length, 1); assert.equal(current.writes.length, current.seeds.length);
      assert.equal(current.config.permission.external_directory, 'deny');
    } finally { await current.close(); }
  });
}

for (const id of ['changed-without-grant', 'denied-source', 'missing-file', 'timeout']) {
  test(`read setup never creates a production mutation grant for ${id}`, async () => {
    const current = await configuration(id);
    try {
      const { maintenancePermissionSnapshot } = await import('../../plugin/maintenance/permission.js');
      for (const operation of ['update', 'delete']) {
        const snapshot = maintenancePermissionSnapshot(current.layers, { database, operation,
          participants: [{ id: current.seeds[0].id, placement: origin }] });
        assert.equal(snapshot.granted, false); assert.equal(snapshot.action, 'deny');
      }
      assert.equal(current.config.permission.memocap_recall.library, 'allow');
    } finally { await current.close(); }
  });
}
