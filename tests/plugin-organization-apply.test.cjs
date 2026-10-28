const assert = require('node:assert/strict');
const test = require('node:test');
const { organizationHost: host, organizationDatabase: database,
  organizationSnapshot: snapshot, organizationReceipt: orgReceipt } = require('./plugin-fixture.cjs');

const applyArgs = (group, dependencies = []) => ({ operation: 'apply', database, confirmed: true,
  request: JSON.stringify({ mode: 'pending', group, dependencies }) });
const postSnapshot = (original, content = original.content) => ({ ...original, content,
  organized_at: '2026-10-28T11:00:00Z', updated_at: '2026-10-28T11:00:00Z' });

test('merge independently reads every participant under the frozen backend after the commit', async (context) => {
  const survivor = snapshot(7);
  const source = snapshot(8);
  const reference = { ...snapshot(9), organized_at: '2026-10-28T09:00:00Z' };
  const content = 'approved "literal" $(nothing)\n中文';
  const persisted = postSnapshot(survivor, content);
  const current = await host(context, (operation, request, options) => {
    assert.equal(options.env.MEMOCAP_DB, database);
    if (operation === 'apply') {
      process.env.MEMOCAP_DB = '/changed/after-commit';
      return orgReceipt(operation, { database, action: 'merge', records: [persisted],
        deleted: [{ id: 8, placement: 'universal' }] }, { outcome: 'committed' });
    }
    assert.deepEqual(request.keys, [{ id: 7, placement: 'universal' }, { id: 8, placement: 'universal' }]);
    return orgReceipt(operation, { database, records: request.keys.map((key) => ({ ...key,
      snapshot: key.id === 7 ? persisted : null })) });
  });
  const payload = await current.execute(applyArgs({ action: 'merge', survivor, sources: [source], content }, [reference]));
  assert.equal(payload.status, 'ok');
  assert.equal(payload.outcome, 'committed');
  assert.equal(payload.untrusted_data.readback.status, 'ok');
  assert.deepEqual(current.organizationCalls.map(({ argv }) => argv[1]), ['apply', 'read']);
  assert.deepEqual(current.asks[0].metadata.request.dependencies, [reference]);
});

test('apply needs prior concrete confirmation and a bound preview database before permission', async (context) => {
  const current = await host(context);
  for (const args of [{ ...applyArgs({ action: 'delete', expected: snapshot() }), confirmed: false },
    { ...applyArgs({ action: 'keep', expected: snapshot() }), database: undefined }]) {
    const payload = await current.execute(args);
    assert.equal(payload.status, 'failed');
    assert.ok(['confirmation_required', 'backend_required'].includes(payload.error.code));
  }
  assert.equal(current.asks.length + current.organizationCalls.length, 0);
});

test('confirmed rollback retains the native conflict receipt and never issues a write or read retry', async (context) => {
  const conflict = orgReceipt('apply', { database, action: 'delete', records: [], deleted: [] }, {
    status: 'rejected', outcome: 'rolled_back', error: { code: 'snapshot_conflict', message: 'changed' } });
  const current = await host(context, () => { throw Object.assign(new Error('native rejected'), {
    code: 'cli_failed', receipt: conflict, outcome: 'rejected' }); });
  const payload = await current.execute(applyArgs({ action: 'delete', expected: snapshot() }));
  assert.equal(payload.status, 'rejected');
  assert.equal(payload.outcome, 'rolled_back');
  assert.equal(payload.error.code, 'snapshot_conflict');
  assert.deepEqual(payload.untrusted_data.receipt, conflict);
  assert.deepEqual(current.organizationCalls.map(({ argv }) => argv[1]), ['apply']);
});

for (const failure of ['timeout', 'invalid_receipt', 'lost_response']) {
  test(`uncertain ${failure} remains unknown even when a deletion is absent on independent read`, async (context) => {
    const current = await host(context, (operation, request) => {
      if (operation === 'apply') throw Object.assign(new Error(failure), { code: failure, outcome: 'outcome_unknown' });
      return orgReceipt(operation, { database, records: request.keys.map((key) => ({ ...key, snapshot: null })) });
    });
    const payload = await current.execute(applyArgs({ action: 'delete', expected: snapshot() }));
    assert.equal(payload.status, 'outcome_unknown');
    assert.equal(payload.no_replay, true);
    assert.equal(payload.untrusted_data.receipt, null);
    assert.equal(payload.untrusted_data.readback.receipt.organization.records[0].snapshot, null);
    assert.deepEqual(current.organizationCalls.map(({ argv }) => argv[1]), ['apply', 'read']);
  });
}

for (const mismatch of ['content', 'tags', 'provenance', 'organized_at', 'deleted_still_present', 'read_failure']) {
  test(`committed receipt survives independent readback ${mismatch} without replay`, async (context) => {
    const persisted = postSnapshot(snapshot(7), 'approved');
    let committed;
    const current = await host(context, (operation, request) => {
      if (operation === 'apply') {
        committed = orgReceipt(operation, { database, action: 'merge', records: [persisted],
          deleted: [{ id: 8, placement: 'universal' }] }, { outcome: 'committed' });
        return committed;
      }
      if (mismatch === 'read_failure') throw Object.assign(new Error('read unavailable'), { code: 'cli_failed' });
      const changed = { ...persisted };
      if (mismatch === 'provenance') changed.provenance = { memory_id: 7, source_memory_id: 3,
        source_placement_kind: 'universal', source_repository_id: null, source_domain_id: null,
        action: 'copy', operation_id: 'transfer', created_at: 'earlier', applicability_note: null };
      else if (mismatch === 'organized_at') changed.organized_at = null;
      else changed[mismatch] = 'concurrent change';
      return orgReceipt(operation, { database, records: request.keys.map((key) => ({ ...key,
        snapshot: key.id === 7 ? changed : mismatch === 'deleted_still_present' ? snapshot(8) : null })) });
    });
    const payload = await current.execute(applyArgs({ action: 'merge', survivor: snapshot(7), sources: [snapshot(8)], content: 'approved' }));
    assert.equal(payload.status, 'outcome_unknown');
    assert.equal(payload.no_replay, true);
    assert.deepEqual(payload.untrusted_data.receipt, committed);
    assert.deepEqual(current.organizationCalls.map(({ argv }) => argv[1]), ['apply', 'read']);
  });
}

test('an apply response cannot redefine the approved survivor metadata even when readback matches it', async (context) => {
  const persisted = { ...postSnapshot(snapshot(), 'approved'), tags: 'not approved' };
  const current = await host(context, (operation, request) => operation === 'apply'
    ? orgReceipt(operation, { database, action: 'refine', records: [persisted], deleted: [] }, { outcome: 'committed' })
    : orgReceipt(operation, { database, records: request.keys.map((key) => ({ ...key, snapshot: persisted })) }));
  const payload = await current.execute(applyArgs({ action: 'refine', expected: snapshot(), content: 'approved' }));
  assert.equal(payload.status, 'outcome_unknown');
  assert.equal(payload.no_replay, true);
});

test('an uncertain apply clears prior automatic recall before the next tool loop', async (context) => {
  const current = await host(context, (operation, request) => {
    if (operation === 'apply') throw Object.assign(new Error('lost response'), { outcome: 'outcome_unknown' });
    return orgReceipt(operation, { database, records: request.keys.map((key) => ({ ...key, snapshot: null })) });
  });
  const state = current.runtime.stateFor('A');
  state.messageID = 'old-message';
  current.runtime.seed(state, ['original'], { status: 'ok', results: [] });
  const generation = state.generation;

  const payload = await current.execute(applyArgs({ action: 'delete', expected: snapshot() }));

  assert.equal(payload.status, 'outcome_unknown');
  assert.equal(state.cache, undefined);
  assert.ok(state.generation > generation);
});
