const assert = require('node:assert/strict');
const test = require('node:test');
const { database, task } = require('./maintenance-fixture.cjs');

test('an exact maintenance grant is scoped to database, placement, operation and every participant', async () => {
  const { maintenancePattern, maintenancePermissionSnapshot } = await import('../plugin/maintenance/permission.js');
  const target = { database, operation: 'update', participants: [{ id: 7, placement: 'universal' }] };
  const pattern = maintenancePattern({ database, operation: 'update', id: 7, placement: 'universal' });
  const policy = { config: { permission: { memocap_maintain: { [pattern]: 'allow' } } }, parent: [], agent: [], session: [] };

  const current = maintenancePermissionSnapshot(policy, target);

  assert.equal(pattern, `v1/db:${Buffer.from(database).toString('base64url')}/placement:dW5pdmVyc2Fs/op:update/id:7`);
  assert.equal(current.granted, true);
  assert.equal(current.action, 'ask');
  assert.equal(maintenancePermissionSnapshot(policy, { ...target, database: '/other.db' }).granted, false);
});

async function fixture(options) {
  const api = await import('../plugin/maintenance/permission.js');
  const target = { database, operation: 'merge', participants: [{ id: 7, placement: 'universal' }, { id: 8, placement: 'universal' }] };
  const patterns = target.participants.map((entry) => api.maintenancePattern({ ...entry, database, operation: 'merge' }));
  const policy = { config: { permission: { memocap_maintain: Object.fromEntries(patterns.map((pattern) => [pattern, 'allow'])) } },
    parent: [], agent: [], session: [] };
  const snapshot = api.maintenancePermissionSnapshot(policy, target);
  const proposal = { proposal_id: 'proposal', task, target, permission_fingerprint: snapshot.fingerprint };
  return { ...api, target, patterns, policy, snapshot, proposal, gate: api.createMaintenancePermissionGate(options) };
}

test('bare allow, broad wildcards, read, organize, or incomplete merge grants cannot authorize maintenance', async () => {
  const current = await fixture();
  for (const permission of ['allow', { memocap_maintain: 'allow' }, { '*': 'allow' },
    { memocap_read: { library: 'allow' }, memocap_organize: 'allow' },
    { memocap_maintain: { 'v1/db:*/placement:*/op:merge/id:*': 'allow' } },
    { memocap_maintain: { [current.patterns[0]]: 'allow' } }]) {
    const snapshot = current.maintenancePermissionSnapshot({ ...current.policy, config: { permission } }, current.target);
    assert.equal(snapshot.granted, false);
    assert.throws(() => current.gate.issue({ ...current.proposal, permission_fingerprint: snapshot.fingerprint }, snapshot),
      { code: 'maintenance_grant_required' });
  }
});

test('id wildcard grants cover the exact placement and operation without wildcard database expansion', async () => {
  const current = await fixture();
  current.policy.config.permission.memocap_maintain = { [current.patterns[0].replace(/id:7$/, 'id:*')]: 'allow' };
  assert.equal(current.maintenancePermissionSnapshot(current.policy, current.target).granted, true);
  for (const target of [{ ...current.target, operation: 'update', participants: [current.target.participants[0]] },
    { ...current.target, participants: current.target.participants.map((entry) => ({ ...entry, placement: 'domain:other' })) }]) {
    assert.equal(current.maintenancePermissionSnapshot(current.policy, target).granted, false);
  }
});

for (const layer of ['config', 'parent', 'agent', 'session']) {
  test(`deny in ${layer} survives later allow rules and prevents a native ask request`, async () => {
    const current = await fixture();
    if (layer === 'config') current.policy.config.permission['*'] = 'deny';
    else current.policy[layer] = [{ permission: '*', pattern: '*', action: 'deny' },
      { permission: 'memocap_maintain', pattern: '*', action: 'allow' }];
    const snapshot = current.maintenancePermissionSnapshot(current.policy, current.target);
    assert.equal(snapshot.action, 'deny');
    assert.throws(() => current.gate.issue({ ...current.proposal, permission_fingerprint: snapshot.fingerprint }, snapshot), { code: 'permission_deny' });
    assert.equal(current.gate.stats().entries, 0);
  });
}

test('native request validation binds all exact targets, rejects forged copies, and authorizes only once', async () => {
  const current = await fixture();
  const request = current.gate.issue(current.proposal, current.snapshot);
  assert.deepEqual(request.patterns, current.patterns);
  assert.deepEqual(request.always, current.patterns);
  assert.throws(() => current.gate.respond(structuredClone(request), 'resolved', current.snapshot), { code: 'ask_response_invalid' });
  const authorization = current.gate.respond(request, 'resolved', current.snapshot);
  current.gate.consume(authorization, current.proposal, current.snapshot);
  assert.throws(() => current.gate.consume(authorization, current.proposal, current.snapshot), { code: 'reference_unavailable' });
});

test('denied or malformed native outcomes remain terminal for that proposal', async () => {
  for (const outcome of ['denied', true, { approved: true }, undefined]) {
    const current = await fixture();
    const request = current.gate.issue(current.proposal, current.snapshot);
    assert.throws(() => current.gate.respond(request, outcome, current.snapshot), { code: outcome === 'denied' ? 'native_permission_denied' : 'ask_response_invalid' });
    assert.throws(() => current.gate.issue(current.proposal, current.snapshot), { code: 'ask_already_requested' });
  }
});

test('revocation or any effective rule change during native ask fails the post-ask recheck', async () => {
  for (const action of ['deny', 'ask']) {
    const current = await fixture();
    const request = current.gate.issue(current.proposal, current.snapshot);
    current.policy.session = [{ permission: 'memocap_maintain', pattern: current.patterns[0], action }];
    const updated = current.maintenancePermissionSnapshot(current.policy, current.target);
    assert.throws(() => current.gate.respond(request, 'resolved', updated), { code: action === 'deny' ? 'permission_deny' : 'permission_changed' });
  }
});

test('cloned authorization or permission snapshots cannot cross the host validation seam', async () => {
  const current = await fixture();
  assert.throws(() => current.gate.issue(current.proposal, structuredClone(current.snapshot)), { code: 'permission_unavailable' });
  const request = current.gate.issue(current.proposal, current.snapshot);
  const authorization = current.gate.respond(request, 'resolved', current.snapshot);
  assert.throws(() => current.gate.consume(structuredClone(authorization), current.proposal, current.snapshot), { code: 'authorization_invalid' });
});

test('permissions remain bounded across TTL, capacity, cancellation and dispose', async () => {
  let now = 0;
  const current = await fixture({ clock: () => now, ttlMs: 10, capacity: 1 });
  const request = current.gate.issue(current.proposal, current.snapshot);
  current.gate.issue({ ...current.proposal, proposal_id: 'second' }, current.snapshot);
  assert.throws(() => current.gate.respond(request, 'resolved', current.snapshot), { code: 'reference_unavailable' });
  now = 10;
  assert.equal(current.gate.stats().bytes, 0);
  current.gate.issue({ ...current.proposal, proposal_id: 'third' }, current.snapshot);
  current.gate.cancel(task);
  assert.equal(current.gate.stats().entries, 0);
  current.gate.dispose();
  assert.throws(() => current.gate.issue(current.proposal, current.snapshot), { code: 'registry_disposed' });
});

test('malformed rules, unsafe IDs, invalid Unicode and forged target shape fail closed', async () => {
  const current = await fixture();
  for (const session of [null, [{}], [{ permission: '*', pattern: '*', action: 'approved' }]]) {
    assert.throws(() => current.maintenancePermissionSnapshot({ ...current.policy, session }, current.target), { name: 'MaintenanceError' });
  }
  for (const change of [{ id: 0 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { placement: 'domain:\ud800' }, { operation: '*' }, { database: '/db?' }]) {
    assert.throws(() => current.maintenancePattern({ id: 7, placement: 'universal', database, operation: 'update', ...change }), { code: 'invalid_request' });
  }
});

for (const cleanup of ['expiry', 'capacity']) {
  test(`a denied live proposal cannot request again after permission ${cleanup} cleanup`, async () => {
    let now = 0;
    const current = await fixture({ clock: () => now, ttlMs: 10, capacity: 1 });
    const request = current.gate.issue(current.proposal, current.snapshot);
    assert.throws(() => current.gate.respond(request, 'denied', current.snapshot), { code: 'native_permission_denied' });
    if (cleanup === 'expiry') { now = 10; current.gate.prune(); }
    else current.gate.issue({ ...current.proposal, proposal_id: 'second' }, current.snapshot);

    assert.throws(() => current.gate.issue(current.proposal, current.snapshot), { code: 'ask_already_requested' });
  });
}

test('authorization for a cloned proposal cannot consume the original proposal', async () => {
  const current = await fixture();
  const clone = structuredClone(current.proposal);
  const request = current.gate.issue(clone, current.snapshot);
  const authorization = current.gate.respond(request, 'resolved', current.snapshot);

  assert.throws(() => current.gate.consume(authorization, current.proposal, current.snapshot), { code: 'authorization_invalid' });
});
