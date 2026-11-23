const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { nativeRuntime } = require('./native-runtime.cjs');
const origin = `repository:${'b'.repeat(64)}`;
const scenarios = Object.freeze({ negative: 'changed-without-grant', recall: 'recalled-unused', invalid: 'recalled-unused' });
async function wireNative(options, charge) {
  const records = new Map();
  const targets = [{ repository_id: origin, canonical_path: options.paths.project, placements: [origin],
    identity_source: 'directory', descriptor: null, observed_at: null }];
  return nativeRuntime({ ...options, node: { path: '/injected/node' }, native: { path: '/injected/native' }, environment: {} }, charge,
    { bridge: { async run(argv, boundary) {
      boundary.beforeSpawn();
      const receipt = { format_version: 1, package_version: require('../../package.json').version, operation_id: randomUUID(),
        operation: argv[0], status: 'ok', backend: 'local', origin: 'cli', targets, results: [], returned_ids: [],
        activity_status: 'not_requested', truncated: false };
      const entry = (snapshot) => ({ memory: snapshot, source_order: 0, visibility: 'visible', applicable_repositories: [], completeness: 'full' });
      switch (argv[0]) {
        case 'scope': receipt.operation = 'scope_resolve'; break;
        case 'status': break;
        case 'remember': {
          assert.ok(records.size < 3, 'wire_seed_bound'); const id = records.size + 71;
          records.set(id, { id, placement: origin, scope: origin, content: argv.at(-1), kind: 'context', tags: '', topic_key: '',
            created_at: '2026-11-15T00:00:00Z', updated_at: '2026-11-15T00:00:00Z', organized_at: null, provenance: null });
          receipt.status = 'inserted'; receipt.returned_ids = [id]; break;
        }
        case 'read': {
          const snapshot = records.get(Number(argv[1])); assert.ok(snapshot, 'wire_unseeded_read');
          receipt.results = [entry(snapshot)]; receipt.returned_ids = [snapshot.id]; break;
        }
        case 'recall': {
          const placement = argv.indexOf('--placement');
          receipt.discovery = placement < 0 ? { kind: 'library' } : { kind: 'origins', placements: [argv[placement + 1]] };
          const { queryTerms } = await import('../../plugin/query.js'); const terms = queryTerms(argv[1]);
          receipt.results = options.fixture_wire === 'invalid' ? [] : [...records.values()]
            .filter((snapshot) => terms.some((term) => snapshot.content.toLowerCase().includes(term.toLowerCase()))).map(entry);
          receipt.returned_ids = receipt.results.map(({ memory }) => memory.id); break;
        }
        case 'organize':
          assert.equal(argv[1], 'read', 'wire_mutation_forbidden'); receipt.operation = 'organize_read'; receipt.targets = [];
          receipt.organization = { database: options.paths.database,
            records: JSON.parse(boundary.stdin).keys.map((key) => ({ ...key, snapshot: records.get(key.id) ?? null })) };
          receipt.returned_ids = receipt.organization.records.filter(({ snapshot }) => snapshot !== null).map(({ id }) => id); break;
        case 'activity': assert.equal(argv[1], 'record'); receipt.activity_status = 'recorded'; break;
        default: assert.fail('wire_native_command_forbidden');
      }
      return { receipt };
    } } });
}
async function wirePacket(scenario, context) {
  assert.ok(Object.hasOwn(scenarios, scenario), 'wire_scenario');
  const { original, adoption_keys } = require('../capture-quality-population/inputs.cjs').resolveCase(scenarios[scenario]);
  const { origin: placement } = await context.call('initialize', {});
  const seeds = [];
  const records = [original.record, ...(original.participants ?? [])];
  for (const record of records) seeds.push(await context.call('seed', { content: record.body, placement }));
  return { seeds, packet: { root: context.session, user: 'Consider the supplied synthetic task.', review: false,
    operations: scenario === 'negative' ? [context.operation] : [], memories: seeds.map((seed, index) => ({ id: seed.id,
      placement: seed.placement, role: index ? 'comparison' : 'primary', access: scenario === 'negative' ? 'read' : 'recall',
       ...(scenario === 'negative' && adoption_keys.includes(records[index].key) ? { declaration: 'Read fully and explicitly declare the statements used through memocap_maintain use.' } : {}),
       ...(scenario !== 'negative' ? { recall_query: seed.content } : {}) })) } };
}
function verifyWire(scenario, report) {
  const outputs = report.events.filter((event) => event.kind === 'tool.output');
  const uses = outputs.filter((event) => event.tool === 'memocap_maintain' && event.receipt.status === 'used');
  assert.equal(report.used.requests ?? 0, 0); assert.equal(report.used.children ?? 0, 0);
  assert.deepEqual(report.final_seed_state.records.map(({ snapshot }) => snapshot), report.seed_bindings.map(({ snapshot }) => snapshot));
  assert.equal(report.events.some((event) => event.kind === 'native.dispatch'), false);
  if (scenario === 'invalid') {
    assert.equal(report.used.scripted_root_dispatches, 1); assert.equal(uses.length, 0);
    assert.equal(report.used.scripted_root_generations, 1); return;
  }
  assert.equal(uses.length, scenario === 'negative' ? 1 : 0);
  assert.equal(outputs.filter((event) => event.tool === 'memocap_recall').length, scenario === 'recall' ? 1 : 0);
}
async function verifyPermissions(scenario, { configured, rules, database, seeds }) {
  const { original } = require('../capture-quality-population/inputs.cjs').resolveCase(scenarios[scenario]);
  const { maintenancePermissionSnapshot } = await import('../../plugin/maintenance/permission.js');
  for (const operation of ['update', 'delete']) assert.equal(maintenancePermissionSnapshot({ config: { permission: configured.permission },
    parent: rules, session: rules, agent: rules }, { database, operation,
    participants: [{ id: seeds[0].id, placement: seeds[0].placement }] }).granted,
    original.authorization.includes(`${operation}:${original.record.key}`));
}
module.exports = { wireNative, wirePacket, verifyWire, verifyPermissions, scenarios };
