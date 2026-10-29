const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { organizationHost: host, organizationDatabase: database,
  organizationSnapshot: snapshot, organizationReceipt: receipt } = require('./plugin-fixture.cjs');

test('invalid JSON, complete-snapshot omissions, cursor misuse and duplicate participants stop before permission', async (context) => {
  const current = await host(context);
  const invalid = [
    { operation: 'page', request: '{' },
    { operation: 'page', request: '{"selection":"pending","extra":true}' },
    { operation: 'page', request: '{"after_id":7}' },
    { operation: 'read', request: '{"keys":[]}', database },
    { operation: 'read', request: '{"keys":[{"id":0,"placement":"universal"}]}', database },
    { operation: 'apply', confirmed: true, database, request: JSON.stringify({ mode: 'pending',
      group: { action: 'keep', expected: { ...snapshot(), provenance: undefined } }, dependencies: [] }) },
    { operation: 'apply', confirmed: true, database, request: JSON.stringify({ mode: 'pending',
      group: { action: 'merge', survivor: snapshot(), sources: [snapshot()] }, dependencies: [], content: 'approved' }) },
  ];
  for (const args of invalid) assert.equal((await current.execute(args)).error.code, 'invalid_request');
  assert.equal(current.asks.length + current.organizationCalls.length, 0);
});

test('database path discovery matches native precedence and freezes relative paths before approval', async (context) => {
  const current = await host(context);
  const { freezeOrganization } = await import('../plugin/organization-backend.js');
  const cases = [
    [{ MEMOCAP_DB: 'custom.db', MEMOCAP_DATA_DIR: '/ignored', MEMOCAP_HOME: '/also-ignored' }, path.resolve('custom.db')],
    [{ MEMOCAP_DB: '', MEMOCAP_DATA_DIR: 'relative-data', MEMOCAP_HOME: '/ignored' }, path.resolve('relative-data/memocap.db')],
    [{ MEMOCAP_DB: '', MEMOCAP_DATA_DIR: '', MEMOCAP_HOME: 'relative-home' }, path.resolve('relative-home/.memocap/memocap.db')],
    [{ MEMOCAP_DB: ' space.db ', MEMOCAP_DATA_DIR: '' }, path.resolve(' space.db ')],
  ];
  for (const [env, expected] of cases) {
    Object.assign(process.env, env);
    const frozen = freezeOrganization({ operation: 'page', request: '{}' }, current.toolContext);
    assert.equal(frozen.database, expected);
    assert.equal(frozen.env.MEMOCAP_DB, expected);
    assert.equal(frozen.cwd, path.parse(process.cwd()).root);
  }
});

test('organized-reference uses its own cursor and exact ordered reads retain absence without disclosure', async (context) => {
  const original = { ...snapshot(), organized_at: '2026-10-28T12:00:00Z' };
  const current = await host(context, (operation, request) => operation === 'page' ? receipt(operation, {
    database, selection: 'organized-reference', upper_id: 9, next_id: 7, exhausted: false, records: [original] }) : receipt(operation, {
    database, records: request.keys.map((key) => ({ ...key, snapshot: key.placement === 'universal' ? original : null })) }));
  const reference = await current.execute({ operation: 'page', database,
    request: '{"selection":"organized-reference","after_id":3,"upper_id":9}' });
  assert.equal(reference.untrusted_data.receipt.organization.records[0].organized_at, original.organized_at);
  const read = await current.execute({ operation: 'read', database, request: JSON.stringify({ keys: [
    { id: 7, placement: 'domain:other' }, { id: 7, placement: 'universal' }] }) });
  assert.equal(read.status, 'ok', JSON.stringify(read));
  assert.deepEqual(read.untrusted_data.receipt.organization.records.map((row) => row.snapshot), [null, original]);
});

test('malformed apply envelopes retain the commit receipt and require independent read without replay', async (context) => {
  const original = snapshot();
  const committed = { ...original, organized_at: '2026-10-28T12:00:00Z' };
  const malformed = receipt('apply', { database, action: 'keep', records: [committed], deleted: [] },
    { outcome: 'committed', operation_id: 'malformed' });
  const current = await host(context, (operation, request) => operation === 'apply' ? malformed : receipt('read', {
    database, records: request.keys.map((key) => ({ ...key, snapshot: committed })) }));
  const output = await current.execute({ operation: 'apply', database, confirmed: true,
    request: JSON.stringify({ mode: 'pending', group: { action: 'keep', expected: original }, dependencies: [] }) });
  assert.equal(output.status, 'outcome_unknown');
  assert.equal(output.no_replay, true);
  assert.deepEqual(output.untrusted_data.receipt, malformed);
  assert.deepEqual(current.organizationCalls.map(({ argv }) => argv[1]), ['apply', 'read']);
});

test('a malformed rollback response cannot claim that apply never committed', async (context) => {
  const malformed = receipt('apply', { database, action: 'delete', records: [], deleted: [] }, {
    status: 'rejected', outcome: 'rolled_back', operation_id: 'malformed', error: { code: 'snapshot_conflict', message: 'unknown' } });
  const current = await host(context, (operation, request) => {
    if (operation === 'apply') throw Object.assign(new Error('native nonzero'), { code: 'cli_failed', receipt: malformed });
    return receipt('read', { database, records: request.keys.map((key) => ({ ...key, snapshot: null })) });
  });
  const output = await current.execute({ operation: 'apply', database, confirmed: true,
    request: JSON.stringify({ mode: 'pending', group: { action: 'delete', expected: snapshot() }, dependencies: [] }) });
  assert.equal(output.status, 'outcome_unknown');
  assert.equal(output.no_replay, true);
  assert.deepEqual(current.organizationCalls.map(({ argv }) => argv[1]), ['apply', 'read']);
});
