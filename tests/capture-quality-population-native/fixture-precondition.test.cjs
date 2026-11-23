const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { toy, digest } = require('./evaluation-fixture.cjs');
const { createEvaluation } = require('./population.cjs');
const { preparePermissions, basePermissions } = require('./permission-configuration.cjs');
const { inventory, createMeter } = require('./inventory.cjs');
const { hash } = require('./value.cjs');
const origin = `repository:${'c'.repeat(64)}`;
function fixture(change = () => {}) {
  const input = toy(); const raw = JSON.parse(input.input_utf8);
  raw.maintenance[0].gold = { action: 'update', mutations: 1,
    operation: { action: 'update', participants: ['toy-key'] } };
  raw.maintenance[0].participants = [{ key: 'comparison', body: 'Comparison.', placement: 'repository:toy' }];
  change(raw.maintenance[0], input.mapping);
  input.input_utf8 = JSON.stringify(raw); input.input_sha256 = digest(input.input_utf8);
  input.mapping.tuning_sha256 = input.input_sha256; input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  return createEvaluation(input);
}
function nativeProbe() {
  const effects = []; let nextID = 17;
  return { effects, native: { async initialize() { effects.push('initialize'); return origin; },
    async seed(record) { effects.push(`seed:${record.content}`); const id = nextID++;
      return { id, ...record, readback: { id, ...record } }; } } };
}
function publicRunner(evaluation) {
  const effects = [];
  const prior = { requests: 0, parent_requests: 0, worker_requests: 0, provider_requests: 0,
    provider_request_bytes: 0, provider_response_bytes: 0 };
  const needed = inventory(evaluation);
  const approval = { approved: true, mode: 'native', approval_id: 'injected-only', limits: needed.limits,
    population_sha256: needed.tuning_sha256, inventory_sha256: hash(needed),
    evaluation_sha256: needed.evaluation_sha256, retained_ledger_sha256: hash(prior) };
  function load(name, deps) {
    const filename = path.join(__dirname, name); const local = createRequire(filename); const module = { exports: {} };
    const injected = (name) => deps[name] ?? local(name); injected.main = null;
    vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(injected, module, module.exports);
    return module.exports;
  }
  const runtime = load('runtime.cjs', {
    'node:fs': { writeFileSync() { effects.push('marker'); }, mkdirSync() { effects.push('mkdir'); },
      readdirSync: () => [], rmdirSync() { effects.push('cleanup'); } },
    './authorization.cjs': { authorize: () => approval, sources: () => ({ digest: 'injected' }) },
    './inventory.cjs': { inventory, createMeter },
    './concrete-host.cjs': { concreteHost() { effects.push('host-helper'); return {}; } },
    './adapter.cjs': { async runCase(id) { effects.push(`case:${id}`);
      return { id, cleanup: { exited: true, children: 0, removed: true, control_stopped: true, listener_closed: true } }; } },
  });
  const driver = load('driver.cjs', { './runtime.cjs': runtime });
  return { effects, run: () => driver.runNative({ evaluation, retained_ledger: prior,
    paths: { attempt: '/injected/attempt', privateRoot: '/injected/root' } }, approval) };
}
const contradictions = [
  ['absent grant despite prose', (row, mapping) => { delete row.authorization; mapping.maintenance_request.text = 'Update and merge all supplied records.'; }, 'fixture_mutation_authorization_mismatch'],
  ['wrong operation', (row) => { row.authorization = ['delete:toy-key']; }, 'fixture_mutation_authorization_mismatch'],
  ['wrong record', (row) => { row.authorization = ['update:comparison']; }, 'fixture_mutation_authorization_mismatch'],
  ['foreign expected participant', (row) => { row.gold.operation.participants = ['foreign']; }, 'fixture_mutation_authorization_mismatch'],
  ['conflicting gold action', (row) => { row.gold.operation.action = 'delete'; }, 'fixture_mutation_authorization_mismatch'],
  ['missing adoption', (row) => { row.used = false; }, 'fixture_mutation_adoption_mismatch'],
  ['explicit merge without comparison adoption', (row) => { row.authorization = ['merge:toy-key,comparison'];
    row.gold = { action: 'merge', mutations: 1, operation: { action: 'merge', participants: ['comparison', 'toy-key'] } }; }, 'fixture_mutation_adoption_mismatch'],
  ['malformed actual grant', (row) => { row.authorization = ['update:foreign']; }, 'fixture_authorization_mismatch'],
];
for (const [label, change, code] of contradictions) {
  test(`setup refuses ${label} before initialization or seed`, async () => {
    const evaluation = fixture(change); const probe = nativeProbe();
    await assert.rejects(preparePermissions('toy-update', probe.native, '/injected/db', evaluation), { code });
    assert.deepEqual(probe.effects, []);
  });
  test(`public driver refuses ${label} before marker or any host helper`, async () => {
    const runner = publicRunner(fixture(change));
    await assert.rejects(runner.run(), { code });
    assert.deepEqual(runner.effects, []);
  });
}
for (const gold of [undefined, { action: 'unknown' }, { action: 'proposal', proposed_action: 'update', mutations: 0 },
  { action: 'keep', mutations: 0, operation: { action: 'merge', participants: ['toy-key', 'comparison'] } }]) {
  test(`nonpositive expectation ${JSON.stringify(gold)} remains executable without auto-grant`, async () => {
    const evaluation = fixture((row) => { row.gold = gold; delete row.authorization; }); const probe = nativeProbe();
    const setup = await preparePermissions('toy-update', probe.native, '/injected/db', evaluation);
    assert.deepEqual(probe.effects, ['initialize', 'seed:Toy primary.', 'seed:Comparison.']);
    assert.equal(basePermissions('toy-update', evaluation)['*'], 'deny');
    assert.equal(setup.permission.memocap_maintain, 'ask');
    const runner = publicRunner(evaluation); const report = await runner.run();
    assert.equal(report.population_status, 'complete');
    assert.deepEqual(runner.effects, ['marker', 'mkdir', 'host-helper', 'case:toy-read', 'host-helper', 'case:toy-update', 'cleanup']);
  });
}
for (const action of ['update', 'delete']) {
  test(`positive ${action} binds only the actual primary operation and key`, async () => {
    const evaluation = fixture((row) => { row.authorization = [`${action}:toy-key`]; row.gold.action = action;
      row.gold.operation.action = action; }); const probe = nativeProbe();
    const setup = await preparePermissions('toy-update', probe.native, '/injected/db', evaluation);
    const { maintenancePermissionSnapshot } = await import('../../plugin/maintenance/permission.js');
    const snapshot = (operation, id) => maintenancePermissionSnapshot({ config: { permission: setup.permission }, parent: [], agent: [], session: [] },
      { database: '/injected/db', operation, participants: [{ id, placement: origin }] });
    assert.equal(snapshot(action, 17).granted, true);
    assert.equal(snapshot(action, 18).granted, false);
    assert.equal(snapshot(action === 'update' ? 'delete' : 'update', 17).granted, false);
  });
}
test('explicit two-adoption merge passes only with its independent exact grant', async () => {
  const evaluation = fixture((row) => { row.adoption_keys = ['comparison', 'toy-key'];
    row.authorization = ['merge:comparison,toy-key'];
    row.gold = { action: 'merge', mutations: 1, operation: { action: 'merge', participants: ['toy-key', 'comparison'] } }; });
  const probe = nativeProbe();
  const setup = await preparePermissions('toy-update', probe.native, '/injected/db', evaluation);
  const { maintenancePermissionSnapshot } = await import('../../plugin/maintenance/permission.js');
  const snapshot = maintenancePermissionSnapshot({ config: { permission: setup.permission }, parent: [], agent: [], session: [] },
    { database: '/injected/db', operation: 'merge', participants: [17, 18].map((id) => ({ id, placement: origin })) });
  assert.equal(snapshot.granted, true);
  const runner = publicRunner(evaluation); assert.equal((await runner.run()).population_status, 'complete');
});
test('explicit adoption cannot supply missing machine grant', async () => {
  const evaluation = fixture((row) => { row.adoption_keys = ['toy-key', 'comparison']; delete row.authorization; });
  const probe = nativeProbe();
  await assert.rejects(preparePermissions('toy-update', probe.native, '/injected/db', evaluation), { code: 'fixture_mutation_authorization_mismatch' });
  assert.deepEqual(probe.effects, []);
});
