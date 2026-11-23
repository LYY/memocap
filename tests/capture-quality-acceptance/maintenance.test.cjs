const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { population, annotations, judged, hash } = require('./examples.cjs');
function issued(input) {
  const item = input.cases.find(({ id }) => id === 'web-404');
  const task = { parentID: item.id, taskID: 'task-started-on-earlier-turn', epoch: 1 };
  const quote = 'The old index is retired.';
  const content_hash = hash(quote);
  const rawDecision = { action: 'delete', target: 'used', retirement_evidence_ids: ['source'], remaining_unique_facts: [],
    citations: [{ source_id: 'source', content_hash, quote }] };
  const decision = { ...rawDecision, citations: [{ ...rawDecision.citations[0], start: 0, end: 25 }] };
  const used = [{ use_id: 'used', task, snapshot: { id: 1, placement: 'synthetic', content: 'Alpha requires approval.' } }];
  const evidence = [{ source_id: 'source', content_hash, text: quote, task, kind: 'retirement', outcome: 'observed', completeness: 'full' }];
  const binding = { kind: 'issued', root: item.id, user: 'u1', workflow: 'maintenance' };
  const fingerprints = { decision_fingerprint: hash([decision, used]), evidence_fingerprint: hash(evidence) };
  const observation = { task, parentID: item.id, user_id: 'u1', review_id: hash([task, 'u1']), ...fingerprints,
    proposal: { proposal_id: 'opaque-1', task, decision, used, evidence, review_status: 'supported', database: 'synthetic',
      target: { database: 'synthetic', operation: 'delete', participants: [{ id: 1, placement: 'synthetic' }] } } };
  const observed = { task, parentID: item.id, user_id: 'u1', review_id: hash([task, 'u1']) };
  item.trace.events.push({ ...binding, kind: 'raw', observation: { ...observed, candidate: { decision: rawDecision }, used, evidence } },
    { ...binding, kind: 'validated', observation: { ...observed, validated: { decision, evidence, ...fingerprints }, used } },
    { ...binding, kind: 'support', observation: { ...observed, assessment: { status: 'supported', ...fingerprints }, ...fingerprints } },
    { ...binding, observation }, { ...binding, kind: 'permission', outcome: 'denied' });
  item.turns[0].result.reviews.push({ parentID: item.id, user_id: 'u1', workflow: 'maintenance', status: 'proposal', reason: 'permission_deny' });
  return item;
}
test('supported issued denied wrong delete counts once, preserving raw wrong proposals', () => {
  const input = population(); const item = issued(input);
  item.trace.events.push(structuredClone(item.trace.events.find(({ kind }) => kind === 'issued')));
  const labels = annotations(); const inventory = collect(input, labels).inventory;
  labels.decisions.push({ ...judged(inventory.decisions[0].key), correct: false });
  labels.proposals.push({ ...judged(inventory.proposals[0].key), correct: false });
  const result = collect(input, labels);
  assert.equal(result.metrics.maintenance_false_delete.denominator, 1);
  assert.equal(result.metrics.maintenance_false_delete.numerator, 1);
  assert.equal(result.inventory.wrong_proposals.length, 1);
  assert.equal(result.inventory.attempts.length, 0);
});
test('malformed unsupported raw mutation remains inspectable without invented issuance', () => {
  const input = population(); input.cases[16].trace.events.push({ kind: 'raw', workflow: 'maintenance', root: 'missing-file', user: 'u1',
    observation: { raw_text: '{"decision":{"action":"delete"', reason: 'invalid_proposal' } });
  const labels = annotations(); const row = collect(input, labels).inventory.proposals[0];
  labels.proposals.push({ ...judged(row.key), correct: false });
  const result = collect(input, labels);
  assert.equal(result.inventory.wrong_proposals.length, 1);
  assert.equal(result.inventory.decisions.length, 0);
});
test('supported issued conflict retains its decision denominator and raw wrong proposal', () => {
  const input = population(); const item = issued(input);
  item.turns[0].result.reviews.at(-1).reason = 'snapshot_changed';
  const labels = annotations(); const inventory = collect(input).inventory;
  labels.decisions.push({ ...judged(inventory.decisions[0].key), correct: false });
  labels.proposals.push({ ...judged(inventory.proposals[0].key), correct: false });

  const result = collect(input, labels);

  assert.deepEqual(result.inventory.decisions[0].missing, []);
  assert.equal(result.metrics.maintenance_false_revision.denominator, 1);
  assert.equal(result.metrics.maintenance_false_delete.denominator, 1);
  assert.equal(result.metrics.maintenance_false_delete.numerator, 1);
  assert.equal(result.inventory.wrong_proposals.length, 1);
  assert.equal(result.inventory.attempts.length, 0);
});
test('missing issued fingerprint linkage blocks rates without discarding opaque ID', () => {
  const input = population(); const item = issued(input);
  delete item.trace.events.find(({ kind }) => kind === 'issued').observation.decision_fingerprint;
  const result = collect(input, annotations());
  assert.equal(result.inventory.decisions.length, 1);
  assert.equal(result.metrics.maintenance_false_revision.denominator, 1);
  assert.equal(result.metrics.maintenance_false_revision.status, 'blocked');
});
test('a foreign repeated opaque proposal ID blocks linkage and is counted only once', () => {
  const input = population(); const item = issued(input);
  input.cases[16].trace.events.push(structuredClone(item.trace.events.find(({ kind }) => kind === 'issued')));
  const result = collect(input, annotations());
  assert.equal(result.inventory.decisions.length, 1);
  assert.equal(result.metrics.maintenance_false_revision.denominator, 1);
  assert.equal(result.metrics.maintenance_false_revision.status, 'blocked');
  assert.equal(result.inventory.decisions[0].observations.length, 2);
});
for (const action of ['delete', 'refine']) test(`erroneous ${action} inventories keep all still-valid pre facts`, () => {
  const input = population(); const item = issued(input);
  const before = { id: 1, placement: 'synthetic', content: 'Alpha requires approval.' };
  const after = action === 'delete' ? null : { ...before, content: 'Alpha has no approval condition.' };
  const request = { mode: 'all', group: { action, expected: before, ...(after ? { content: after.content } : {}) }, dependencies: [] };
  const binding = { root: item.id, user: 'u1', workflow: 'maintenance', attempt: 'delete-attempt' };
  const dispatch = { ...binding, kind: 'native.dispatch', request, database: 'synthetic', permission: 'resolved', session: 'worker', message: 'm', tool: 'memocap_maintain' };
  const receipt = { operation: 'organize_maintain', operation_id: 'delete-commit', status: 'ok', error_present: false, records: [] };
  item.trace.events.push({ ...binding, kind: 'permission', session: 'worker', message: 'm', tool: 'memocap_maintain', outcome: 'resolved' },
    { ...binding, kind: 'consume', session: 'worker', message: 'm' }, dispatch,
    { ...binding, kind: 'native.commit', receipt, post: { records: after ? [after] : [], deleted: after ? [] : [before] } },
    { ...binding, kind: 'native.readback', receipt: { status: 'ok', error_present: false, operation_id: 'read-delete' },
      organization: { database: 'synthetic', records: [{ id: 1, placement: 'synthetic', snapshot: after }] } });
  const labels = annotations(); const mutation = collect(input, labels).inventory.mutations[0];
  labels.mutations.push({ ...judged(mutation.key), participants: [{ id: 1, placement: 'synthetic',
    pre_content_hash: hash(request.group.expected.content), post_content_hash: after ? hash(after.content) : null, inventory_complete: true,
    facts: [{ id: 'approval', text: 'Approval required.', still_valid: true, preserved: false, rationale: 'Wrong mutation lost approval.' }] }] });
  const result = collect(input, labels);
  assert.equal(result.metrics.maintenance_condition_loss.denominator, 1);
  assert.equal(result.metrics.maintenance_condition_loss.numerator, 1);
});
