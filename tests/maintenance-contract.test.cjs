const assert = require('node:assert/strict');
const test = require('node:test');
const { maintenanceFixture: fixture, caller, snapshot, fullRead, declaration, hash } = require('./maintenance-fixture.cjs');

test('a frozen supported update consumes only its ID and retains every exact expected snapshot', async () => {
  const current = await fixture();
  current.review();
  const proposal = current.registry.freeze(current.decision, current.host);
  current.authorize(proposal);

  const consumed = current.registry.consume(proposal.proposal_id);

  assert.deepEqual(consumed.request, { mode: 'all', group: { action: 'refine', expected: current.records[0], content: 'new route' }, dependencies: [] });
  assert.equal(Object.isFrozen(consumed.request.group.expected), true);
  assert.throws(() => current.registry.consume(proposal.proposal_id), { code: 'reference_unavailable' });
});

test('merge consumes only actual-used participants under their separate merge grants', async () => {
  const current = await fixture();
  current.rebind('merge', [0, 1]);
  const decision = { ...current.decision, action: 'merge', sources: [current.used[1].use_id] };
  current.review(decision);
  const proposal = current.registry.freeze(decision, current.host);
  current.authorize(proposal);

  const consumed = current.registry.consume(proposal.proposal_id);

  assert.deepEqual(consumed.request.group, { action: 'merge', survivor: current.records[0], sources: [current.records[1]], content: 'new route' });
  assert.deepEqual(consumed.request.dependencies, []);
});

test('merge preserves declared source order independently of used record order', async () => {
  const current = await fixture();
  current.rebind('merge', [0, 2, 1]);
  current.host.use_ids = current.used.map((entry) => entry.use_id);
  const decision = { ...current.decision, action: 'merge', sources: [current.used[2].use_id, current.used[1].use_id] };
  current.review(decision);
  const proposal = current.registry.freeze(decision, current.host);
  current.authorize(proposal);

  const consumed = current.registry.consume(proposal.proposal_id);

  assert.deepEqual(consumed.request, { mode: 'all', group: { action: 'merge', survivor: snapshot(), content: 'new route',
    sources: [snapshot(9, 'C condition'), snapshot(8, 'B route')] }, dependencies: [] });
});

test('delete needs explicit host retirement evidence and a supported assessment declaring no unique facts', async () => {
  const current = await fixture();
  current.rebind('delete', [0]);
  current.host.evidence = [{ ...current.evidence[0], kind: 'retirement' }];
  const decision = { action: 'delete', target: current.used[0].use_id, citations: [current.citation], retirement_evidence_ids: ['observed'], remaining_unique_facts: [] };
  current.review(decision);
  const proposal = current.registry.freeze(decision, current.host);
  current.authorize(proposal);

  const consumed = current.registry.consume(proposal.proposal_id);

  assert.deepEqual(consumed.request.group, { action: 'delete', expected: current.records[0] });
});

for (const action of ['keep', 'unknown']) {
  test(`${action} records produce no mutation capability or permission request`, async () => {
    const current = await fixture();
    const proposal = current.registry.freeze({ action, target: current.used[0].use_id }, { ...current.host, permission: null });

    assert.equal(proposal.target, null);
    assert.throws(() => current.registry.consume(proposal.proposal_id), { code: 'no_mutation' });
    assert.equal(current.gate.stats().entries, 0);
  });
}

for (const outcome of ['missing', '404', 'timeout', 'deny']) {
  test(`source ${outcome} stays unknown even with a structurally supported retirement declaration`, async () => {
    const current = await fixture();
    current.rebind('delete', [0]);
    current.host.evidence = [{ ...current.evidence[0], kind: 'retirement', outcome }];
    const decision = { action: 'delete', target: current.used[0].use_id, citations: [current.citation], retirement_evidence_ids: ['observed'], remaining_unique_facts: [] };
    current.review(decision);

    const proposal = current.registry.freeze(decision, current.host);

    assert.equal(proposal.decision.action, 'unknown');
    assert.throws(() => current.registry.consume(proposal.proposal_id), { code: 'no_mutation' });
  });
}

test('fragmentary evidence and absent, unsupported or unknown model assessment cannot dispatch', async () => {
  for (const status of [null, 'unknown', 'unsupported']) {
    const current = await fixture();
    current.review();
    current.host.review = status === null ? null : { ...current.host.review, status };
    const proposal = current.registry.freeze(current.decision, current.host);
    assert.throws(() => current.registry.consume(proposal.proposal_id), { code: 'assessment_required' });
  }
  const current = await fixture();
  current.host.evidence = [{ ...current.evidence[0], completeness: 'fragment' }];
  const proposal = current.registry.freeze(current.decision, current.host);
  assert.equal(proposal.decision.action, 'unknown');
});

test('an empty unique-facts claim cannot replace explicit retirement evidence', async () => {
  const current = await fixture();
  const decision = { action: 'delete', target: current.used[0].use_id, citations: [current.citation], retirement_evidence_ids: ['observed'], remaining_unique_facts: [] };

  assert.throws(() => current.registry.freeze(decision, current.host), { code: 'retirement_required' });
  current.host.evidence = [{ ...current.evidence[0], kind: 'retirement' }];
  assert.throws(() => current.registry.freeze({ ...decision, remaining_unique_facts: ['retained fact'] }, current.host), { code: 'retirement_required' });
});

test('malformed or forged citations cannot change the host evidence or its Unicode codepoint boundaries', async () => {
  const current = await fixture();
  for (const citation of [{ ...current.citation, source_id: 'forged' }, { ...current.citation, content_hash: '0'.repeat(64) },
    { ...current.citation, start: 2 }, { ...current.citation, quote: '\ud800' }, { ...current.citation, end: 1.5 },
    { ...current.citation, end: 999 }, { ...current.citation, start: -1 }, { ...current.citation, raw: true }]) {
    assert.throws(() => current.registry.freeze({ ...current.decision, citations: [citation] }, current.host), { name: 'MaintenanceError' });
  }
  for (const evidence of [{ ...current.evidence[0], content_hash: '0'.repeat(64) },
    { ...current.evidence[0], task: { ...current.host.task, epoch: 99 } }, { ...current.evidence[0], raw_activity: [] }]) {
    assert.throws(() => current.registry.freeze(current.decision, { ...current.host, evidence: [evidence] }), { name: 'MaintenanceError' });
  }
});

test('unregistered, duplicate, cross-task and cross-placement participants cannot become merge targets', async () => {
  const current = await fixture();
  for (const sources of [['forged'], [current.used[0].use_id], [current.used[1].use_id, current.used[1].use_id]]) {
    assert.throws(() => current.registry.freeze({ ...current.decision, action: 'merge', sources }, current.host), { name: 'MaintenanceError' });
  }
  assert.throws(() => current.registry.freeze(current.decision, { ...current.host, task: { ...current.host.task, taskID: 'another' } }), { code: 'task_mismatch' });
  assert.throws(() => current.registry.freeze({ ...current.decision, target: '7' }, current.host), { code: 'reference_unavailable' });
});

test('proposal snapshots and evidence are detached, deeply frozen, and bound to assessment fingerprints', async () => {
  const current = await fixture();
  current.review();
  const proposal = current.registry.freeze(current.decision, current.host);
  current.decision.content = 'model rewrite after freeze';
  current.host.evidence[0].text = 'tampered';

  assert.equal(proposal.decision.content, 'new route');
  assert.equal(Object.isFrozen(proposal.evidence[0].task), true);
  assert.equal(Reflect.set(proposal.decision, 'content', 'forged'), false);
  assert.throws(() => current.registry.freeze(current.decision, current.host), { code: 'evidence_hash_mismatch' });
  assert.throws(() => current.registry.consume({ proposal_id: proposal.proposal_id, content: 'forged' }), { code: 'invalid_request' });
});

test('assessment becomes stale when output, evidence or the actual-used dependency set changes', async () => {
  for (const change of ['output', 'evidence', 'dependencies']) {
    const current = await fixture();
    current.review();
    if (change === 'output') current.decision.content = 'different';
    if (change === 'evidence') current.host.evidence = [{ ...current.evidence[0], kind: 'validation' }];
    if (change === 'dependencies') current.host.use_ids.push(current.used[1].use_id);
    assert.throws(() => current.registry.freeze(current.decision, current.host), { code: 'review_mismatch' });
  }
});

for (const change of ['epoch', 'database', 'body', 'metadata', 'missing', 'permission']) {
  test(`post-ask ${change} change invalidates the single consumable proposal`, async () => {
    const current = await fixture();
    current.review();
    const proposal = current.registry.freeze(current.decision, current.host);
    current.authorize(proposal);
    if (change === 'epoch') current.state.task = { ...current.state.task, epoch: 5 };
    if (change === 'database') current.state.database = '/synthetic/changed.db';
    if (change === 'body') current.state.records = [{ ...current.records[0], content: 'changed' }];
    if (change === 'metadata') current.state.records = [{ ...current.records[0], organized_at: 'now' }];
    if (change === 'missing') current.state.records = [];
    if (change === 'permission') {
      current.policy.session = [{ permission: 'memocap_maintain', pattern: '*', action: 'deny' }];
      current.state.permission = current.maintenancePermissionSnapshot(current.policy, current.target);
    }

    assert.throws(() => current.registry.consume(proposal.proposal_id), { name: 'MaintenanceError' });
    assert.throws(() => current.registry.consume(proposal.proposal_id), { code: 'reference_unavailable' });
  });
}

test('all used dependencies are frozen, rechecked and passed to the native CAS request', async () => {
  const current = await fixture();
  current.host.use_ids = [current.used[2].use_id, current.used[0].use_id, current.used[1].use_id];
  current.state.records = [current.records[2], current.records[0], current.records[1]];
  current.review();
  const proposal = current.registry.freeze(current.decision, current.host);
  current.authorize(proposal);

  const consumed = current.registry.consume(proposal.proposal_id);

  assert.deepEqual(consumed.request, { mode: 'all', group: { action: 'refine', expected: snapshot(), content: 'new route' },
    dependencies: [snapshot(9, 'C condition'), snapshot(8, 'B route')] });
});

test('expiry, capacity, task cancellation and dispose release receipts, uses, proposals and permissions', async () => {
  let now = 0;
  const current = await fixture({ clock: () => now, ttlMs: 10, capacity: 3 });
  current.review();
  const first = current.registry.freeze(current.decision, current.host);
  current.authorize(first);
  for (let index = 0; index < 3; index++) current.registry.freeze(current.decision, current.host);
  assert.throws(() => current.registry.inspect(first.proposal_id), { code: 'reference_unavailable' });
  now = 10;
  current.registry.prune();
  for (const stats of Object.values(current.registry.stats())) assert.equal(stats.bytes, 0);
  current.registry.cancel(current.host.task);
  current.registry.dispose();
  for (const stats of Object.values(current.registry.stats())) assert.equal(stats.disposed, true);
});

test('proposal entry budgets reject oversized decisions and permit at most a 30 second lifetime', async () => {
  const current = await fixture();
  for (const content of ['', 'x'.repeat(1201), '\ud800', null, undefined]) {
    assert.throws(() => current.registry.freeze({ ...current.decision, content }, current.host), { name: 'MaintenanceError' });
  }
  assert.throws(() => current.createMaintenanceRegistry({ usage: current.usage, permissionGate: current.gate, current: () => current.state, ttlMs: 30001 }), { code: 'invalid_limits' });
});

test('delete rejects malformed citation arrays through the validation seam', async () => {
  const current = await fixture();
  current.host.evidence = [{ ...current.evidence[0], kind: 'retirement' }];
  for (const citations of [null, {}, undefined]) {
    const decision = { action: 'delete', target: current.used[0].use_id, citations, retirement_evidence_ids: ['observed'], remaining_unique_facts: [] };
    assert.throws(() => current.registry.freeze(decision, current.host), { name: 'MaintenanceError' });
  }
});

test('an actually used record from another placement still cannot join a merge', async () => {
  const current = await fixture();
  const record = { ...snapshot(10, 'other scope fact'), placement: 'domain:other' };
  const receipt = current.usage.registerFullRead(fullRead(record), caller);
  const used = current.usage.declareUse(declaration(receipt, [record.content]), caller, record);
  current.host.use_ids.push(used.use_id);
  const decision = { ...current.decision, action: 'merge', sources: [used.use_id] };

  assert.throws(() => current.registry.freeze(decision, current.host), { code: 'placement_mismatch' });
});

test('cancellation clears a live proposal, its successful native response and every use in that exact task', async () => {
  const current = await fixture();
  current.review();
  const proposal = current.registry.freeze(current.decision, current.host);
  current.authorize(proposal);

  current.registry.cancel(current.host.task);

  for (const stats of Object.values(current.registry.stats())) assert.deepEqual([stats.entries, stats.bytes], [0, 0]);
  assert.throws(() => current.registry.consume(proposal.proposal_id), { code: 'reference_unavailable' });
});

test('oversized complete evidence is rejected as a whole before retaining a proposal', async () => {
  const current = await fixture();
  const text = 'x'.repeat(16384);
  current.host.evidence.push(...[1, 2, 3, 4].map((index) => ({ ...current.evidence[0], source_id: `source-${index}`, text, content_hash: hash(text) })));

  assert.throws(() => current.registry.freeze(current.decision, current.host), { code: 'input_budget' });
  assert.deepEqual(current.registry.stats().proposals, { entries: 0, bytes: 0, disposed: false });
});
