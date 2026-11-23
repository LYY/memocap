const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { compileFunction } = require('node:vm');
const { fixturePermissions, basePermissions } = require('./permission-configuration.cjs');
const { resolveCase } = require('../capture-quality-population/inputs.cjs');
const origin = `repository:${'b'.repeat(64)}`;
const location = { origin, database: '/synthetic/memory.db', root: '/synthetic/project/private', worktree: '/synthetic/project' };
const cases = [
  ['missing-file', null, []], ['web-404', 'delete', [71]], ['timeout', null, []], ['denied-source', null, []],
  ['irrelevant-change', 'update', [71]], ['verified-condition-update', 'update', [71]], ['changed-without-grant', null, []],
  ['recalled-unused', 'update', [71]], ['snapshot-conflict', 'update', [71]],
  ['merge-unique-conditions', 'merge', [71, 72]], ['verified-retirement', 'delete', [71]], ['lost-response', 'update', [71]],
];
function seedsFor(original) {
  return [original.record, ...(original.participants ?? [])].map((record, index) => {
    const seeded = { id: 71 + index, placement: origin, content: record.body };
    return { ...seeded, readback: { ...seeded } };
  });
}
function substituted(original) {
  const filename = require.resolve('./permission-configuration.cjs');
  const record = { exports: {} };
  const localRequire = (name) => name === './population.cjs' ? { population: () => ({ resolveCase: () => ({ original }) }) } : require(name);
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module'], { filename,
    importModuleDynamically: (specifier) => import(new URL(specifier, require('node:url').pathToFileURL(filename))) })(localRequire, record);
  return record.exports;
}
for (const [id, operation, ids] of cases) test(`original authorization alone determines effective grant for ${id}`, async () => {
  const original = resolveCase(id).original;
  const seeds = seedsFor(original);
  const configured = await fixturePermissions(id, location, seeds);
  const root = configured.root({ operations: [] });
  const layers = { config: { permission: configured.permission }, parent: root, agent: root, session: root };
  const { maintenancePermissionSnapshot, maintenancePattern } = await import('../../plugin/maintenance/permission.js');
  if (operation) {
    const participants = ids.map((id) => ({ id, placement: origin }));
    const target = { database: location.database, operation, participants };
    const snapshot = maintenancePermissionSnapshot(layers, target);
    assert.equal(snapshot.granted, true); assert.equal(snapshot.action, 'allow');
    const patterns = participants.map((key) => maintenancePattern({ ...key, database: location.database, operation }));
    assert.deepEqual(Object.keys(configured.permission.memocap_maintain), patterns);
    assert.deepEqual(root.filter((rule) => rule.permission === 'memocap_maintain'), patterns.map((pattern) => ({ permission: 'memocap_maintain', pattern, action: 'allow' })));
    assert.equal(basePermissions(id)['*'], 'ask');
    for (const changed of [{ database: '/foreign/db' }, { operation: operation === 'delete' ? 'update' : 'delete', participants: participants.slice(0, 1) },
      { participants: participants.map((key, index) => index ? key : { ...key, id: 99 }) },
      { participants: participants.map((key) => ({ ...key, placement: 'universal' })) }]) {
      assert.equal(maintenancePermissionSnapshot(layers, { ...target, ...changed }).granted, false);
    }
    if (id === 'verified-retirement') assert.equal(maintenancePermissionSnapshot(layers, { ...target, participants: [{ id: 72, placement: origin }] }).granted, false);
  } else {
    assert.equal(configured.permission.memocap_maintain, 'ask');
    for (const operation of ['update', 'delete']) assert.equal(maintenancePermissionSnapshot(layers,
      { database: location.database, operation, participants: [{ id: 71, placement: origin }] }).granted, false);
  }
  assert.equal(configured.permission.memocap_read.library, 'allow');
  assert.equal(configured.permission.memocap_recall.library, 'allow');
});
for (const [reason, change] of [
  ['unknown_operation', (value) => { value.authorization = ['copy:alpha-route']; }],
  ['unknown_participant', (value) => { value.authorization = ['merge:alpha-route,foreign']; }],
  ['duplicate_participant', (value) => { value.authorization = ['merge:alpha-route,alpha-route']; }],
  ['missing_participant', (value) => { value.authorization = ['merge:alpha-route']; }],
  ['duplicate_record_key', (value) => { value.participants[0].key = value.record.key; }],
]) test(`original grant rejects ${reason} before producing permission`, async () => {
  const original = structuredClone(resolveCase('merge-unique-conditions').original); change(original);
  await assert.rejects(substituted(original).fixturePermissions('merge-unique-conditions', location, seedsFor(original)), { code: 'fixture_authorization_mismatch' });
});
for (const [reason, change] of [
  ['duplicate_id', (seeds) => { seeds[1].id = seeds[0].id; seeds[1].readback.id = seeds[0].id; }],
  ['swapped_body', (seeds) => { [seeds[0], seeds[1]] = [seeds[1], seeds[0]]; }],
  ['foreign_placement', (seeds) => { seeds[1].placement = 'universal'; }],
  ['wrong_readback', (seeds) => { seeds[1].readback.content = 'unrelated'; }],
  ['missing_seed', (seeds) => { seeds.pop(); }],
]) test(`merge grant rejects ${reason} seed binding`, async () => {
  const original = resolveCase('merge-unique-conditions').original; const seeds = seedsFor(original); change(seeds);
  await assert.rejects(fixturePermissions('merge-unique-conditions', location, seeds), { code: 'permission_seed_binding_required' });
});
