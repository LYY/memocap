const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { population, annotations, judged, hash } = require('./examples.cjs');

function maintenance(action = 'delete') {
  const input = population(); const item = input.cases.find((row) => row.id === (action === 'delete' ? 'verified-retirement' : 'verified-condition-update'));
  const task = { parentID: item.id, taskID: 'task-started-on-earlier-turn', epoch: 1 };
  const snapshot = (id, content) => ({ id, placement: 'repository:' + 'a'.repeat(64), scope: 'repository', content, kind: 'fact', tags: '',
    topic_key: '', created_at: '2026-11-14T00:00:00Z', updated_at: '2026-11-14T00:00:00Z', organized_at: null, provenance: null });
  const before = snapshot(1, 'Approval required.');
  const dependency = snapshot(2, 'Independent dependency.');
  const source = snapshot(3, 'Unique source information.');
  const after = { ...before, content: 'Approval and unique source information.' };
  const text = 'Retired with no remaining unique facts.';
  const evidence = [{ source_id: 'source-evidence', task, kind: action === 'delete' ? 'retirement' : 'source', outcome: 'observed',
    completeness: 'full', text, content_hash: hash(text) }];
  const citations = [{ source_id: 'source-evidence', start: 0, end: text.length, quote: text, content_hash: hash(text) }];
  const decision = { action: action === 'refine' ? 'update' : action, target: 'used', citations,
    ...(action === 'delete' ? { retirement_evidence_ids: ['source-evidence'], remaining_unique_facts: [] } : { content: after.content }),
    ...(action === 'merge' ? { sources: ['source'] } : {}) };
  const used = [{ use_id: 'used', task, database: 'synthetic', snapshot: before }, { use_id: 'dependency', task, database: 'synthetic', snapshot: dependency },
    ...(action === 'merge' ? [{ use_id: 'source', task, database: 'synthetic', snapshot: source }] : [])];
  const fingerprints = { decision_fingerprint: hash([decision, used]), evidence_fingerprint: hash(evidence) };
  const binding = { root: item.id, user: 'u1', workflow: 'maintenance' };
  const members = action === 'merge' ? [before, source] : [before];
  const observation = { task, parentID: item.id, user_id: binding.user, review_id: hash([task, binding.user]) };
  const proposal = { proposal_id: 'proof-opaque', task, decision, used, evidence, review_status: 'supported', database: 'synthetic',
    target: { database: 'synthetic', operation: decision.action, participants: members.map(({ id, placement }) => ({ id, placement })) } };
  const request = { mode: 'all', group: action === 'merge' ? { action, survivor: before, sources: [source], content: after.content }
    : { action, expected: before, ...(action === 'refine' ? { content: after.content } : {}) }, dependencies: [dependency] };
  const dispatch = { ...binding, kind: 'native.dispatch', attempt: 'proof-attempt', session: 'worker', message: 'm',
    tool: 'memocap_maintain', permission: 'resolved', database: 'synthetic', request };
  const post = { records: action === 'delete' ? [] : [after], deleted: action === 'merge' ? [source] : action === 'delete' ? [before] : [] };
  const readback = { ...binding, kind: 'native.readback', attempt: dispatch.attempt,
    receipt: { operation_id: 'independent-read', status: 'ok', error_present: false }, organization: { database: 'synthetic', records: [
      ...post.records.map((snapshot) => ({ id: snapshot.id, placement: snapshot.placement, snapshot })),
      ...post.deleted.map(({ id, placement }) => ({ id, placement, snapshot: null })),
      { id: dependency.id, placement: dependency.placement, snapshot: dependency }] } };
  const commit = { ...binding, kind: 'native.commit', attempt: dispatch.attempt, post,
    receipt: { operation: 'organize_maintain', operation_id: 'proof-write', status: 'ok', error_present: false } };
  item.trace.events.push({ ...binding, kind: 'raw', observation: { ...observation, candidate: { decision }, used, evidence } },
    { ...binding, kind: 'validated', observation: { ...observation, validated: { decision, evidence, ...fingerprints }, used } },
    { ...binding, kind: 'support', observation: { ...observation, assessment: { status: 'supported', ...fingerprints }, ...fingerprints } },
    { ...binding, kind: 'issued', observation: { ...observation, ...fingerprints, proposal } },
    { ...binding, kind: 'permission', session: dispatch.session, message: dispatch.message, tool: dispatch.tool, outcome: 'resolved' },
    { ...binding, kind: 'consume', session: dispatch.session, message: dispatch.message }, dispatch, commit, readback,
    { ...dispatch, kind: 'tool.output', args: { operation: 'apply' }, receipt: { operation_id: 'proof-write', status: 'committed', outcome: 'committed',
      untrusted_data: { receipt: { operation: 'organize_maintain', operation_id: 'proof-write', status: 'ok', error: null, organization: post }, readback: readback.organization } } });
  item.turns[0].result.reviews.push({ parentID: item.id, user_id: 'u1', workflow: 'maintenance', status: 'committed' });
  const labels = annotations(); const inventory = collect(input).inventory;
  labels.decisions = inventory.decisions.map((row) => ({ ...judged(row.key), correct: true }));
  labels.proposals = inventory.proposals.map((row) => ({ ...judged(row.key), correct: true }));
  labels.reviews = inventory.reviews.filter((row) => row.semantic).map((row) => ({ ...judged(row.key), unknown: false }));
  labels.mutations = inventory.mutations.map((row) => ({ ...judged(row.key), participants: row.participants.map((pre) => ({
    id: pre.id, placement: pre.placement, pre_content_hash: hash(pre.content),
    post_content_hash: post.deleted.some((entry) => entry.id === pre.id) ? null : hash(after.content), inventory_complete: true,
    facts: [{ id: `fact-${pre.id}`, text: pre.content, still_valid: true, preserved: true, rationale: 'Synthetic source comparison.' }] })) }));
  return { input, labels, item, commit, readback, dispatch, dependency };
}

test('B4 rejects dependency-only observation when the delete participant has no post state', () => {
  const { input, labels, commit, readback, dependency } = maintenance();
  commit.post = { records: [], deleted: [] };
  readback.organization.records = [{ id: dependency.id, placement: dependency.placement, snapshot: dependency }];
  delete labels.mutations[0].participants[0].post_content_hash;
  labels.mutations[0].participants[0].facts = [];

  const result = collect(input, labels);

  assert.equal(result.inventory.attempts[0].verified, false);
  assert.equal(result.metrics.missed_maintenance.status, 'blocked');
  assert.equal(result.metrics.missed_maintenance.denominator, 2);
  assert.equal(result.metrics.missed_maintenance.value, null);
  assert.equal(result.metrics.maintenance_condition_loss.status, 'blocked');
});

for (const action of ['delete', 'refine', 'merge']) test(`B4 verifies every ${action} participant and dependency`, () => {
  const { input, labels } = maintenance(action);

  const result = collect(input, labels);

  assert.equal(result.inventory.attempts[0].verified, true);
  assert.deepEqual(result.inventory.decisions[0].missing, []);
  assert.equal(result.inventory.mutations[0].issued_key, result.inventory.decisions[0].key);
  assert.equal(result.metrics.missed_maintenance.status, 'observed');
  assert.equal(result.metrics.missed_maintenance.denominator, 2);
  assert.equal(result.metrics.missed_maintenance.numerator, action === 'merge' ? 2 : 1);
  assert.equal(result.metrics.maintenance_condition_loss.status, 'observed');
  assert.equal(result.metrics.maintenance_condition_loss.denominator, action === 'merge' ? 2 : 1);
});

for (const variant of ['refine', 'delete', 'unmarked', 'tampered source', 'duplicate source', 'tampered decision', 'foreign mark', 'stale mark']) test(`one-short raw citation: ${variant}`, () => {
  const action = variant === 'delete' ? 'delete' : 'refine';
  const corrected = variant === action;
  const { input, labels, item } = maintenance(action);
  const raw = item.trace.events.find((row) => row.kind === 'raw');
  const validated = item.trace.events.find((row) => row.kind === 'validated');
  raw.observation = structuredClone(raw.observation);
  raw.observation.candidate.decision.citations[0].end -= 1;
  if (action === 'delete') raw.observation.evidence[0].kind = 'source';
  if (variant === 'tampered source') raw.observation.evidence[0].text += ' Extra.';
  if (variant === 'duplicate source') raw.observation.evidence.push({ ...raw.observation.evidence[0] });
  if (variant === 'tampered decision') raw.observation.candidate.decision.content += ' Extra.';
  const marked = { ...validated, observation: { ...validated.observation, citation_offset_correction: 'exclusive_end_plus_one' } };
  if (variant === 'foreign mark') item.trace.events.splice(item.trace.events.indexOf(validated), 0,
    { ...marked, observation: { ...marked.observation, task: { ...marked.observation.task, epoch: 0 } } });
  else if (variant === 'stale mark') item.trace.events.splice(item.trace.events.indexOf(raw), 0, marked);
  else if (variant !== 'unmarked') validated.observation = marked.observation;
  labels.proposals[0].correct = false;
  if (variant === 'foreign mark' || variant === 'stale mark') {
    labels.proposals[0].key = JSON.stringify([item.id, item.trace.events.indexOf(raw)]);
  }
  const originalRaw = structuredClone(raw.observation);
  const issuedKey = action === 'delete' ? '["verified-retirement","proof-opaque"]' : '["verified-condition-update","proof-opaque"]';

  const result = collect(input, labels);

  assert.equal(result.inventory.attempts[0].verified, true);
  assert.deepEqual(result.inventory.proposals[0].observation, originalRaw);
  assert.deepEqual(raw.observation, originalRaw);
  const { status, numerator, denominator } = result.metrics.all_wrong_proposals;
  assert.deepEqual({ status, numerator, denominator }, { status: 'observed', numerator: 1, denominator: 1 });
  assert.deepEqual(result.inventory.decisions[0].missing, corrected ? [] : ['issued:task_fingerprint_support_link']);
  assert.equal(result.inventory.mutations[0].issued_key, corrected ? issuedKey : null);
  assert.equal(result.metrics.missed_maintenance.status, corrected ? 'observed' : 'blocked');
});

for (const variant of ['valid', 'source and quote', 'changed evidence', 'foreign source', 'wrong span', 'duplicate identity', 'wrong content',
  'missing task binding', 'late raw', 'early support', 'late support', 'marker with offsets']) test(`raw quote proof: ${variant}`, () => {
  const { input, labels, item } = maintenance('refine');
  const events = item.trace.events;
  const [raw, validated, support, issued] = events.filter((row) => ['raw', 'validated', 'support', 'issued'].includes(row.kind));
  raw.observation = structuredClone(raw.observation);
  const decision = raw.observation.candidate.decision;
  const [{ source_id, content_hash, quote }] = decision.citations;
  const citation = variant === 'source and quote' ? { source_id, quote } : { source_id, content_hash, quote };
  decision.citations = [citation];
  if (variant === 'changed evidence') raw.observation.evidence[0].text += ' Extra.';
  if (variant === 'foreign source') citation.source_id = 'foreign';
  if (variant === 'wrong span') citation.quote = citation.quote.slice(1);
  if (variant === 'duplicate identity') raw.observation.evidence.push({ ...raw.observation.evidence[0] });
  if (variant === 'wrong content') decision.content += ' Extra.';
  if (variant === 'missing task binding') delete raw.observation.task;
  if (variant === 'marker with offsets') {
    Object.assign(citation, { start: 0, end: citation.quote.length - 2 });
    validated.observation.citation_offset_correction = 'exclusive_end_plus_one';
  }
  const moveAfter = (moved, after) => {
    events.splice(events.indexOf(moved), 1);
    events.splice(events.indexOf(after) + 1, 0, moved);
  };
  if (variant === 'late raw') moveAfter(raw, validated);
  if (variant === 'early support') moveAfter(validated, support);
  if (variant === 'late support') moveAfter(support, issued);
  labels.proposals[0].key = JSON.stringify([item.id, events.indexOf(raw)]);
  const original = structuredClone(raw.observation);

  const result = collect(input, labels);

  assert.deepEqual(result.inventory.proposals[0].observation, original);
  const linked = variant === 'valid' || variant === 'source and quote';
  assert.deepEqual(result.inventory.decisions[0].missing, linked ? [] : ['issued:task_fingerprint_support_link']);
  assert.equal(result.inventory.mutations[0].issued_key, linked ? result.inventory.decisions[0].key : null);
  assert.equal(result.inventory.attempts[0].verified, true);
});

for (const stage of ['raw', 'validated', 'support', 'issued']) for (const field of ['taskID', 'parentID', 'epoch', 'user_id', 'review_id', 'decision_fingerprint', 'evidence_fingerprint']) {
  test(`task identity rejects foreign ${stage} ${field}`, () => {
    const { input, labels, item } = maintenance();
    const event = item.trace.events.find((row) => row.kind === stage);
    event.observation = structuredClone(event.observation);
    if (['user_id', 'review_id', 'decision_fingerprint', 'evidence_fingerprint'].includes(field)) event.observation[field] = 'foreign';
    else event.observation.task[field] = field === 'epoch' ? 2 : 'foreign';

    const result = collect(input, labels);

    assert.equal(result.inventory.mutations[0].issued_key, null);
    assert.equal(result.metrics.missed_maintenance.status, 'blocked');
    assert.equal(result.metrics.missed_maintenance.denominator, 2);
    assert.equal(result.inventory.decisions.length, 1);
  });
}

for (const variant of ['used-task', 'dependency-task', 'validated-used', 'stale-fingerprint', 'mixed-old-task-new-user', 'foreign-current-user', 'foreign-request']) {
  test(`task identity rejects ${variant}`, () => {
    const { input, labels, item, dispatch } = maintenance('refine');
    const issued = item.trace.events.find((row) => row.kind === 'issued');
    const validated = item.trace.events.find((row) => row.kind === 'validated');
    if (variant === 'used-task' || variant === 'dependency-task') {
      issued.observation.proposal = structuredClone(issued.observation.proposal);
      issued.observation.proposal.used[variant === 'used-task' ? 0 : 1].task.taskID = 'foreign';
      const proposal = issued.observation.proposal;
      const fingerprint = hash([proposal.decision, proposal.used]);
      issued.observation.decision_fingerprint = fingerprint;
      item.trace.events.find((row) => row.kind === 'raw').observation.used = structuredClone(proposal.used);
      validated.observation.used = structuredClone(proposal.used);
      validated.observation.validated.decision_fingerprint = fingerprint;
      const support = item.trace.events.find((row) => row.kind === 'support').observation;
      support.assessment.decision_fingerprint = fingerprint; support.decision_fingerprint = fingerprint;
    }
    if (variant === 'validated-used') {
      validated.observation.used = structuredClone(validated.observation.used);
      validated.observation.used[0].snapshot.content = 'Foreign preimage.';
    }
    if (variant === 'stale-fingerprint') validated.observation.validated.decision_fingerprint = 'stale';
    if (variant === 'mixed-old-task-new-user') {
      issued.observation.user_id = 'new-user';
      issued.observation.review_id = hash([issued.observation.task, 'new-user']);
    }
    if (variant === 'foreign-current-user') dispatch.user = 'foreign-user';
    if (variant === 'foreign-request') dispatch.request = { ...dispatch.request, dependencies: [] };
    const before = JSON.stringify([input, labels]);

    const result = collect(input, labels);

    assert.equal(result.inventory.mutations[0].issued_key, null);
    assert.equal(result.metrics.missed_maintenance.status, 'blocked');
    assert.equal(result.metrics.missed_maintenance.denominator, 2);
    assert.equal(JSON.stringify([input, labels]), before);
  });
}

for (const variant of ['missing-taskID', 'legacy-userID', 'extra-userID', 'negative-epoch', 'missing-current-user']) {
  test(`task identity rejects ${variant} without a compatibility task format`, () => {
    const { input, labels, item } = maintenance();
    const issued = item.trace.events.find((row) => row.kind === 'issued').observation;
    if (variant === 'missing-current-user') delete issued.user_id;
    else {
      const task = { ...issued.task };
      if (variant === 'missing-taskID' || variant === 'legacy-userID') delete task.taskID;
      if (variant === 'legacy-userID' || variant === 'extra-userID') task.userID = issued.user_id;
      if (variant === 'negative-epoch') task.epoch = -1;
      issued.task = task; issued.proposal = { ...issued.proposal, task }; issued.review_id = hash([task, issued.user_id]);
    }

    const result = collect(input, labels);

    assert.equal(result.inventory.mutations[0].issued_key, null);
    assert.equal(result.metrics.missed_maintenance.status, 'blocked');
    assert.equal(result.metrics.maintenance_false_revision.denominator, 1);
  });
}

for (const omitted of ['participant', 'dependency', 'merge-source']) test(`B4 blocks an omitted ${omitted}`, () => {
  const { input, labels, commit, readback } = maintenance(omitted === 'merge-source' ? 'merge' : 'refine');
  const id = { participant: 1, dependency: 2, 'merge-source': 3 }[omitted];
  commit.post.records = commit.post.records.filter((entry) => entry.id !== id);
  commit.post.deleted = commit.post.deleted.filter((entry) => entry.id !== id);
  readback.organization.records = readback.organization.records.filter((entry) => entry.id !== id);

  const result = collect(input, labels);

  assert.equal(result.inventory.attempts[0].verified, false);
  assert.equal(result.metrics.missed_maintenance.status, 'blocked');
});

for (const facts of [{}, [null]]) test(`C1 reports malformed maintenance fact inventory ${JSON.stringify(facts)}`, () => {
  const { input, labels } = maintenance(); labels.mutations[0].participants[0].facts = facts;

  const result = collect(input, labels);

  assert.equal(result.inventory.mutations.length, 1);
  assert.equal(result.metrics.maintenance_condition_loss.status, 'blocked');
  assert.equal(result.metrics.maintenance_condition_loss.value, null);
});

for (const field of ['status', 'outcome', 'operation_id', 'inner_operation', 'inner_organization', 'readback', 'missing_readback']) {
  test(`actual maintenance envelope rejects tampered ${field}`, () => {
    const { input, item } = maintenance();
    const event = item.trace.events.find((row) => row.kind === 'tool.output');
    event.receipt = structuredClone(event.receipt);
    if (['status', 'outcome', 'operation_id'].includes(field)) event.receipt[field] = 'foreign';
    if (field === 'inner_operation') event.receipt.untrusted_data.receipt.operation_id = 'foreign';
    if (field === 'inner_organization') event.receipt.untrusted_data.receipt.organization.deleted = [];
    if (field === 'readback') event.receipt.untrusted_data.readback.records = [];
    if (field === 'missing_readback') delete event.receipt.untrusted_data.readback;
    const result = collect(input);
    assert.equal(result.inventory.attempts[0].verified, false);
    assert.equal(result.metrics.missed_maintenance.status, 'blocked');
  });
}
