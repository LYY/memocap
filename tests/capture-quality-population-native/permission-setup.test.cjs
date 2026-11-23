const assert = require('node:assert/strict');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { control, wire } = require('./control.cjs');
const { install } = require('./plugin-runtime.cjs');
const { sources } = require('./authorization.cjs');
const { productionProbe } = require('./production-probe.cjs');
const { fixturePermissions, preparePermissions } = require('./permission-configuration.cjs');
const { resolveCase } = require('../capture-quality-population/inputs.cjs');
const origin = `repository:${'c'.repeat(64)}`;
const database = '/synthetic/memory.db';
const record = resolveCase('verified-condition-update').original.record;
const seeded = { id: 8317, placement: origin, content: record.body };
const receipt = { ...seeded, readback: { ...seeded } };

for (const [reason, change] of [['missing', () => []], ['mismatched_readback', () => [{ ...receipt, readback: { ...seeded, id: 1 } }]],
  ['unsafe_id', () => [{ ...receipt, id: 0 }]], ['foreign_origin', () => [{ ...receipt, placement: 'universal' }]],
  ['unrelated_record', () => [{ ...receipt, content: 'not the seeded original' }]]]) {
  test(`positive maintenance configuration rejects ${reason} seed binding before producing a grant`, async () => {
    await assert.rejects(fixturePermissions('verified-condition-update', { database, origin }, change()), { code: 'permission_seed_binding_required' });
  });
}

test('setup consumes each verified native seed once and never replays a mutation for readback', async () => {
  const calls = [];
  const setup = await preparePermissions('verified-condition-update', { initialize: async () => origin,
    seed: async (request) => { calls.push(request); return receipt; } }, database);
  assert.equal(setup.seed(seeded).id, 8317);
  assert.throws(() => setup.seed(seeded), { code: 'seed_setup_mismatch' });
  assert.equal(calls.length, 1);
});

test('plugin configuration and actual serialized initialize/seed commands share one verified setup without native replay', async () => {
  const probe = await productionProbe(); const channel = control('offline-token'); const charges = [];
  channel.bind({ charge: (...args) => charges.push(args) });
  const send = (options, receive) => {
    const request = new PassThrough(); Object.assign(request, { method: options.method, url: options.path, headers: options.headers });
    const response = new PassThrough(); response.statusCode = 200;
    response.writeHead = (status) => { response.statusCode = status; receive(response); };
    request.setTimeout = () => {}; void channel.handler(request, response); return request;
  };
  const calls = []; const rpc = wire('/synthetic/socket', 'offline-token', send);
  const plugin = await install({ client: { session: {} }, directory: '/synthetic/project', serverUrl: new URL('http://127.0.0.1:4444') }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: sources().digest, approval_id: 'offline-only',
    socket: '/synthetic/socket', token: 'offline-token', privateRoot: '/synthetic', paths: { database },
    endpoints: [], case: 'verified-condition-update',
  }, { rpc, fetch: async () => { throw new Error('network_forbidden'); },
    fixture: (input, seam) => require('./fixture.cjs').createFixture(input, { ...seam, factory: probe.factory }),
    native: { invoke: async () => { throw new Error('native_forbidden'); }, uncertain: () => false,
      initialize: async () => { calls.push('initialize'); return origin; },
      seed: async () => { calls.push('seed'); return receipt; } } });
  const config = { provider: { 'openai-b1': { options: {} } } };
  await plugin.config(config);
  const pumping = plugin.qualityPump(); await channel.ready;
  try {
    const initialized = await channel.call('initialize', {});
    const returned = await channel.call('seed', { content: record.body, placement: origin });
    assert.equal(initialized.origin, origin); assert.equal(returned.id, 8317);
    assert.deepEqual(calls, ['initialize', 'seed']);
    await assert.rejects(channel.call('seed', { content: record.body, placement: origin }), { code: 'seed_setup_mismatch' });
    assert.deepEqual(calls, ['initialize', 'seed']);
    const { maintenancePermissionSnapshot } = await import('../../plugin/maintenance/permission.js');
    assert.equal(maintenancePermissionSnapshot({ config, parent: [], agent: [], session: [] }, {
      database, operation: 'update', participants: [{ id: returned.id, placement: returned.placement }],
    }).granted, true);
    assert.equal((await channel.call('close', {})).children, 0); await pumping;
    assert.deepEqual(probe.defaults, []);
  } finally { channel.stop(); await plugin.dispose(); }
});

test('configuration setup uses the existing finite native inventory for every declared case', async () => {
  const { population } = require('./population.cjs');
  const { caseLimits, inventory } = require('./inventory.cjs');
  const { nativeRuntime } = require('./native-runtime.cjs');
  const totals = {};
  for (const { id } of population().mapping.cases) {
    const used = {}; const stored = new Map(); let nextID = 8317;
    const limits = caseLimits(id); const project = `/synthetic/${id}/project`; const caseDB = `/synthetic/${id}/memory.db`;
    const native = await nativeRuntime({ paths: { project, database: caseDB }, native: { path: '/inert/native' },
      node: { path: '/inert/node' }, environment: {} }, (key, amount = 1) => {
      used[key] = (used[key] ?? 0) + amount; assert.ok(used[key] <= limits[key], `${id}/${key}`);
    }, { bridge: { async run(argv, options) {
      options.beforeSpawn();
      if (argv[0] === 'scope') return { receipt: { targets: [{ repository_id: origin }] } };
      if (argv[0] === 'status') return { receipt: {} };
      if (argv[0] === 'remember') {
        const allocated = nextID++; stored.set(allocated, { id: allocated, placement: origin, content: argv.at(-1) });
        return { receipt: { status: 'inserted', operation_id: `write-${allocated}`, returned_ids: [allocated] } };
      }
      if (argv[0] === 'read') return { receipt: { operation: 'read', status: 'ok', truncated: false,
        operation_id: `read-${argv[1]}`, results: [{ memory: stored.get(Number(argv[1])) }] } };
      assert.deepEqual(argv, ['organize', 'read']);
      const key = JSON.parse(options.stdin).keys[0];
      return { receipt: { organization: { records: [{ snapshot: stored.get(key.id) }] } } };
    } } });
    const setup = await preparePermissions(id, native, caseDB);
    const physical = structuredClone(used);
    const { original } = resolveCase(id);
    for (const expected of original.record ? [original.record, ...(original.participants ?? [])] : []) {
      assert.equal(setup.seed({ content: expected.body, placement: origin }).content, expected.body);
    }
    assert.deepEqual(used, physical);
    assert.equal(stored.size, limits.seed_calls);
    for (const [key, amount] of Object.entries(used)) totals[key] = (totals[key] ?? 0) + amount;
  }
  const limits = inventory().limits;
  assert.equal(totals.initialization_writes, limits.host_opens);
  assert.equal(totals.native_calls, limits.host_opens * 2 + limits.seed_calls * 3);
  assert.equal(totals.native_reads, limits.seed_calls * 2);
  assert.equal(totals.native_processes, totals.native_calls * 2 + limits.host_opens);
});
