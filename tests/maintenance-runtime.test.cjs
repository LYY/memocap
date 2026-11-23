const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./maintenance-integration/fixture.cjs');

test('native read exposes a receipt which use rechecks against a complete snapshot', async (context) => {
  const host = await fixture(context);
  const read = await host.read();
  assert.equal(typeof read.maintenance_read?.receipt_id, 'string');
  const used = await host.use(read.maintenance_read);
  assert.equal(used.status, 'used');
  assert.deepEqual(used.spans, [{ start: 0, end: 9, quote: 'old route' }]);
  assert.equal(host.writes.length, 0);
});

test('forged and extra identity arguments never produce adoption', async (context) => {
  const host = await fixture(context);
  const read = await host.read();
  for (const change of [{ receipt_id: 'forged' }, { database: '/forged.db' }, { epoch: 12 }, { source_id: 'forged' }]) {
    const result = await host.use({ ...read.maintenance_read, ...change });
    assert.notEqual(result.status, 'used');
  }
  assert.equal(host.writes.length, 0);
});

test('changed full metadata rejects adoption after a successful read', async (context) => {
  const host = await fixture(context);
  const read = await host.read();
  host.records[0].tags = 'revised';
  assert.equal((await host.use(read.maintenance_read)).error.code, 'snapshot_changed');
});
