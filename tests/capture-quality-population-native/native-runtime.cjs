const path = require('node:path');
const { requireStage, hash } = require('./value.cjs');
const { commandOf } = require('../capture-quality-native/native-proxy.cjs');

async function nativeRuntime(settings, charge, dependencies = {}) {
  const bridge = dependencies.bridge ?? (await import('../../plugin/bridge.js')).createBridge({
    launcher: path.resolve(__dirname, '../../bin/cli.cjs'), executable: settings.node.path });
  let first = true; let uncertain = false;
  const seeded = new Map(); const operations = new Set();
  const env = { ...settings.environment, MEMOCAP_BINARY: settings.native.path, MEMOCAP_DB: settings.paths.database };
  async function invoke(argv, options = {}) {
    const command = commandOf(argv);
    requireStage(['read', 'recall', 'status', 'scope', 'activity', 'organize', 'remember'].includes(command) &&
      (command !== 'scope' || argv[1] === 'resolve') &&
      (command !== 'organize' || ['page', 'read', 'maintain'].includes(argv[1])) &&
      (command !== 'activity' || argv[1] === 'record'), 'unexpected_native_command');
    requireStage(!uncertain || ['read', 'organize'].includes(command) && argv[1] !== 'maintain', 'unknown_write_no_retry');
    if (first) { charge('native_processes'); first = false; }
    let dispatched = false;
    try {
      return await bridge.run(argv, { ...options, cwd: settings.paths.project, env, beforeSpawn() {
        options.beforeSpawn?.(); dispatched = true;
      } });
    } catch (error) {
      if (dispatched && (command === 'remember' || command === 'organize' && argv[1] === 'maintain')) uncertain = true;
      throw error;
    }
  }
  async function setup(argv, options) { charge('native_calls'); charge('native_processes', 2); return (await invoke(argv, options)).receipt; }
  let origin;
  async function initialize() {
    const receipt = await setup(['scope', 'resolve', '--repo', settings.paths.project]);
    origin = receipt.targets?.[0]?.repository_id;
    requireStage(/^repository:[a-f0-9]{64}$/.test(origin ?? ''), 'private_repository_identity_missing');
    charge('initialization_writes'); await setup(['status']); return origin;
  }
  async function seed(snapshot) {
    requireStage(snapshot.placement === origin, 'seed_private_origin');
    charge('setup_writes'); charge('seed_calls');
    const result = await setup(['remember', '--repository-id', origin, '--', snapshot.content]);
    const id = result.returned_ids?.[0];
    requireStage(['inserted', 'updated'].includes(result.status) && Number.isSafeInteger(id), 'seed_receipt_unknown');
    charge('native_reads');
    const read = await setup(['read', String(id), '--placement', origin, '--repository-id', origin]);
    const memory = read.results?.[0]?.memory;
    requireStage(read.operation_id !== result.operation_id && read.operation === 'read' && read.status === 'ok' && read.truncated === false &&
      memory?.id === id && memory.placement === origin && memory.content === snapshot.content, 'seed_independent_readback');
    charge('native_reads');
    const organization = await setup(['organize', 'read'], { stdin: JSON.stringify({ keys: [{ id, placement: origin }] }) });
    const frozen = organization.organization?.records?.[0]?.snapshot;
    requireStage(frozen?.id === id && frozen.placement === origin && frozen.content === snapshot.content &&
      hash(frozen.content) === hash(snapshot.content), 'seed_snapshot_missing');
    const verified = { id, placement: origin, content: memory.content, snapshot: frozen,
      readback: { id, placement: origin, content: memory.content, snapshot: frozen }, receipts: { write: result, read, organization } };
    requireStage(!seeded.has(id), 'seed_duplicate_id'); seeded.set(id, structuredClone(verified));
    for (const receipt of [result, read, organization]) if (receipt.operation_id) operations.add(receipt.operation_id);
    return verified;
  }
  async function readSeedState(keys) {
    requireStage(Array.isArray(keys) && keys.length > 0 && keys.length <= 3 &&
      new Set(keys.map((key) => key.id)).size === keys.length && keys.every((key) =>
        Object.keys(key).length === 2 && seeded.has(key.id) && key.placement === origin), 'final_seed_keys_invalid');
    charge('native_reads');
    const receipt = await setup(['organize', 'read'], { stdin: JSON.stringify({ keys }) });
    const records = receipt.organization?.records;
    requireStage(receipt.operation === 'organize_read' && receipt.status === 'ok' && receipt.truncated === false &&
      typeof receipt.operation_id === 'string' && receipt.operation_id.length > 0 && !operations.has(receipt.operation_id) &&
      Array.isArray(records) && records.length === keys.length && new Set(records.map((record) => record.id)).size === keys.length &&
      records.every((record) => keys.some((key) => key.id === record.id && key.placement === record.placement) &&
        (record.snapshot === null || record.snapshot?.id === record.id && record.snapshot.placement === origin &&
          typeof record.snapshot.content === 'string')), 'final_seed_read_unknown');
    const { parseSnapshot } = await import('../../plugin/maintenance/boundary.js');
    for (const record of records) if (record.snapshot !== null) parseSnapshot(record.snapshot);
    operations.add(receipt.operation_id);
    return { keys: structuredClone(keys), records, receipt };
  }
  return { invoke, initialize, seed, readSeedState, uncertain: () => uncertain };
}
module.exports = { nativeRuntime };
