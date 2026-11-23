const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { population } = require('./population.cjs');
const { requireStage } = require('./value.cjs');
const { adoptionKeys } = require('../capture-quality-population/inputs.cjs');

function revision(original) {
  const authorization = original.authorization ?? [];
  requireStage(Array.isArray(authorization) && authorization.length <= 1, 'fixture_authorization_mismatch');
  if (!authorization.length) return null;
  requireStage(typeof authorization[0] === 'string', 'fixture_authorization_mismatch');
  const [operation, named, extra] = authorization[0].split(':');
  const keys = named?.split(',') ?? [];
  const records = [original.record, ...(original.participants ?? [])];
  requireStage(!extra && ['update', 'delete', 'merge'].includes(operation) &&
    keys.length === (operation === 'merge' ? 2 : 1) && new Set(keys).size === keys.length &&
    records.every((record) => record && typeof record.key === 'string') &&
    new Set(records.map((record) => record.key)).size === records.length &&
    keys.every((key) => records.some((record) => record.key === key)), 'fixture_authorization_mismatch');
  return { operation, indices: keys.map((key) => records.findIndex((record) => record.key === key)) };
}
function fixturePrecondition({ original }) {
  const adopted = adoptionKeys(original);
  const declared = revision(original);
  const gold = original.gold;
  if (gold?.mutations !== 1) return;
  const action = gold.operation?.action ?? gold.action;
  const participants = gold.operation ? gold.operation.participants : [original.record?.key];
  const records = [original.record, ...(original.participants ?? [])];
  requireStage(declared && action === gold.action && action === declared.operation &&
    Array.isArray(participants) && participants.length === declared.indices.length &&
    new Set(participants).size === participants.length &&
    declared.indices.every((index) => participants.includes(records[index].key)), 'fixture_mutation_authorization_mismatch');
  requireStage(declared.indices.every((index) => adopted.includes(records[index].key)), 'fixture_mutation_adoption_mismatch');
}
function validateInstancePath({ root, worktree }) {
  requireStage([root, worktree].every((value) => typeof value === 'string' && path.isAbsolute(value) &&
    path.normalize(value) === value && !/[*?\\\0]/.test(value)), 'native_instance_path_invalid');
  const relative = path.relative(worktree, root);
  requireStage(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'native_instance_path_invalid');
}
function basePermissions(id, evaluation) {
  return { '*': revision(population(evaluation).resolveCase(id).original) ? 'ask' : 'deny', external_directory: 'deny', read: 'deny', bash: 'deny',
    memocap_recall: { library: 'allow' }, memocap_read: { library: 'allow' } };
}
async function fixturePermissions(id, location, seeds) {
  const { original } = population(location.evaluation).resolveCase(id);
  requireStage(/^repository:[a-f0-9]{64}$/.test(location.origin ?? ''), 'private_repository_identity_missing');
  const declared = revision(original);
  const permission = basePermissions(id, location.evaluation);
  const patterns = [];
  if (declared) {
    const records = [original.record, ...(original.participants ?? [])];
    requireStage(seeds.length === records.length && seeds.every((seed, index) => Number.isSafeInteger(seed.id) && seed.id > 0 &&
      seed.placement === location.origin && seed.content === records[index].body && seed.readback?.id === seed.id &&
      seed.readback.placement === seed.placement && seed.readback.content === seed.content) &&
      new Set(seeds.map((seed) => seed.id)).size === seeds.length, 'permission_seed_binding_required');
    const { maintenancePattern } = await import('../../plugin/maintenance/permission.js');
    for (const index of declared.indices) patterns.push(maintenancePattern({ database: location.database,
      operation: declared.operation, id: seeds[index].id, placement: seeds[index].placement }));
    permission.memocap_maintain = Object.fromEntries(patterns.map((pattern) => [pattern, 'allow']));
  } else permission.memocap_maintain = 'ask';
  return { permission, root(packet) {
    validateInstancePath(location);
    const sourceRules = packet.operations.map(({ tool, input: args }) => {
      if (tool !== 'read') return { permission: tool, pattern: args.command, action: 'allow' };
      requireStage(typeof args.filePath === 'string' && path.isAbsolute(args.filePath) &&
        path.normalize(args.filePath) === args.filePath && !/[*?\\\0]/.test(args.filePath), 'native_source_path_invalid');
      const relative = path.relative(location.root, args.filePath);
      requireStage(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'native_source_path_invalid');
      return { permission: tool, pattern: path.relative(location.worktree, args.filePath), action: 'allow' };
    });
    return [{ permission: '*', pattern: '*', action: declared ? 'ask' : 'deny' },
      ...['read', 'bash', 'external_directory'].map((permission) => ({ permission, pattern: '*', action: 'deny' })),
      ...sourceRules,
      ...['memocap_recall', 'memocap_read'].map((permission) => ({ permission, pattern: 'library', action: 'allow' })),
      { permission: 'memocap_remember', pattern: location.origin, action: 'allow' },
      ...(declared ? patterns.map((pattern) => ({ permission: 'memocap_maintain', pattern, action: 'allow' })) :
        [{ permission: 'memocap_maintain', pattern: '*', action: 'ask' }])];
  } };
}
async function preparePermissions(id, native, database, evaluation) {
  const selected = population(evaluation).resolveCase(id);
  fixturePrecondition(selected);
  const { original } = selected;
  const origin = await native.initialize();
  const seeds = [];
  for (const record of original.record ? [original.record, ...(original.participants ?? [])] : []) {
    seeds.push(await native.seed({ content: record.body, placement: origin }));
  }
  const configured = await fixturePermissions(id, { origin, database, evaluation }, seeds);
  let cursor = 0;
  return { origin, permission: configured.permission, seed(request) {
    const seeded = seeds[cursor];
    requireStage(seeded && request.placement === seeded.placement && request.content === seeded.content, 'seed_setup_mismatch');
    cursor++;
    return structuredClone(seeded);
  }, seedKeys(bindings) {
    requireStage(cursor === seeds.length && Array.isArray(bindings) && bindings.length === seeds.length &&
      bindings.every((binding, index) => isDeepStrictEqual(binding, seeds[index])), 'final_seed_binding_mismatch');
    return seeds.map(({ id, placement }) => ({ id, placement }));
  } };
}
module.exports = { basePermissions, fixturePermissions, preparePermissions, validateInstancePath, fixturePrecondition };
