const { createHash } = require('node:crypto');

const database = '/synthetic/memory.db';
const task = { parentID: 'parent', taskID: 'task', epoch: 4 };
const caller = { ...task, sessionID: 'parent', messageID: 'message', callID: 'call' };
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const snapshot = (id = 7, content = 'A😀中 route') => ({ id, placement: 'universal', scope: 'global', content,
  kind: 'context', tags: '', topic_key: '', created_at: '2026-11-12T00:00:00Z',
  updated_at: '2026-11-12T00:00:00Z', organized_at: null, provenance: null });
const fullRead = (record = snapshot()) => ({ operation: 'read', status: 'ok', completeness: 'full',
  database, snapshot: record, content_hash: hash(record.content) });
const declaration = (receipt, statements = ['😀中']) => ({ receipt_id: receipt.receipt_id,
  id: receipt.id, placement: receipt.placement, content_hash: receipt.content_hash, statements });

async function maintenanceFixture(options = {}) {
  const usageAPI = await import('../plugin/maintenance/usage.js');
  const permissionAPI = await import('../plugin/maintenance/permission.js');
  const contractAPI = await import('../plugin/maintenance/contract.js');
  const usage = usageAPI.createUsageRegistry(options);
  const gate = permissionAPI.createMaintenancePermissionGate(options);
  const records = [snapshot(), snapshot(8, 'B route'), snapshot(9, 'C condition')];
  const used = records.map((record) => usage.declareUse(declaration(usage.registerFullRead(fullRead(record), caller), [record.content]), caller, record));
  const evidence = [{ source_id: 'observed', task, kind: 'source', outcome: 'observed', completeness: 'full',
    text: 'A😀中 new route', content_hash: hash('A😀中 new route') }];
  const citation = { source_id: 'observed', start: 1, end: 3, quote: '😀中', content_hash: evidence[0].content_hash };
  const decision = { action: 'update', target: used[0].use_id, content: 'new route', citations: [citation] };
  const target = { database, operation: 'update', participants: [{ id: 7, placement: 'universal' }] };
  const pattern = permissionAPI.maintenancePattern({ database, operation: 'update', id: 7, placement: 'universal' });
  const policy = { config: { permission: { memocap_maintain: { [pattern]: 'allow' } } }, parent: [], agent: [], session: [] };
  const permission = permissionAPI.maintenancePermissionSnapshot(policy, target);
  const host = { task, database, use_ids: [used[0].use_id], evidence, permission, review: null };
  const state = { task, database, records: [records[0]], permission, authorization: null };
  const registry = contractAPI.createMaintenanceRegistry({ usage, permissionGate: gate, current: () => state, ...options });
  function review(input = decision) {
    const validated = contractAPI.validateMaintenanceDecision(input, { used: host.use_ids.map((handle) => usage.getUse(handle, task)), evidence: host.evidence });
    host.review = { status: 'supported', decision_fingerprint: validated.decision_fingerprint, evidence_fingerprint: validated.evidence_fingerprint };
  }
  function authorize(proposal) {
    const request = gate.issue(proposal, host.permission);
    state.authorization = gate.respond(request, 'resolved', state.permission);
  }
  function rebind(operation, indices) {
    host.use_ids = indices.map((index) => used[index].use_id);
    state.records = indices.map((index) => records[index]);
    const participants = indices.map((index) => ({ id: records[index].id, placement: records[index].placement }));
    const patterns = participants.map((entry) => permissionAPI.maintenancePattern({ database, operation, ...entry }));
    policy.config.permission.memocap_maintain = Object.fromEntries(patterns.map((entry) => [entry, 'allow']));
    host.permission = permissionAPI.maintenancePermissionSnapshot(policy, { database, operation, participants });
    state.permission = host.permission;
  }
  return { ...contractAPI, ...permissionAPI, usage, gate, registry, used, records, evidence, citation, decision, target, policy, host, state, review, authorize, rebind };
}

module.exports = { database, task, caller, hash, snapshot, fullRead, declaration, maintenanceFixture };
