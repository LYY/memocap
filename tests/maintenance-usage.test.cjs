const assert = require('node:assert/strict');
const test = require('node:test');
const { task, caller, hash, snapshot, fullRead, declaration } = require('./maintenance-fixture.cjs');

test('host full read plus explicit adoption produces immutable Unicode codepoint spans', async () => {
  const { createUsageRegistry } = await import('../plugin/maintenance/usage.js');
  const registry = createUsageRegistry();
  const record = snapshot();
  const receipt = registry.registerFullRead(fullRead(record), caller);

  const used = registry.declareUse(declaration(receipt), caller, record);

  assert.deepEqual(used.spans, [{ start: 1, end: 3, quote: '😀中' }]);
  assert.deepEqual(registry.getUse(used.use_id, task).snapshot, record);
  assert.ok(Object.isFrozen(used.snapshot) && Object.isFrozen(used.spans[0]));
  registry.dispose();
});

for (const change of [
  { operation: 'recall' }, { status: 'failed' }, { completeness: 'partial' }, { completeness: 'unknown' },
  { content_hash: hash('other') }, { snapshot: { ...snapshot(), id: 0 } },
  { snapshot: { ...snapshot(), placement: 'library' } }, { snapshot: { ...snapshot(), content: '\ud800' } },
  { snapshot: { ...snapshot(), provenance: undefined } }, { database: '/db/*' }, { forged: true },
]) {
  test(`full-read registration rejects malformed host observations ${JSON.stringify(change)}`, async () => {
    const { createUsageRegistry } = await import('../plugin/maintenance/usage.js');
    const registry = createUsageRegistry();
    assert.throws(() => registry.registerFullRead({ ...fullRead(), ...change }, caller), { name: 'MaintenanceError' });
    assert.equal(registry.stats().entries, 0);
  });
}

test('recall-shaped or forged handles and caller identity cannot declare use', async () => {
  const { createUsageRegistry } = await import('../plugin/maintenance/usage.js');
  const registry = createUsageRegistry();
  const receipt = registry.registerFullRead(fullRead(), caller);
  const attempts = [
    [declaration({ ...receipt, receipt_id: 'invented' }), caller],
    [{ ...declaration(receipt), taskID: task.taskID }, caller],
    [declaration(receipt), { ...caller, taskID: 'another' }],
    [declaration(receipt), { ...caller, epoch: 5 }],
    [declaration(receipt), { ...caller, sessionID: 'worker' }],
    [{ ...declaration(receipt), id: 8 }, caller],
    [{ ...declaration(receipt), placement: 'domain:other' }, caller],
    [{ ...declaration(receipt), content_hash: hash('changed') }, caller],
    [{ ...declaration(receipt), statements: ['\udfff'] }, caller],
  ];
  for (const [input, nativeCaller] of attempts) assert.throws(() => registry.declareUse(input, nativeCaller, snapshot()), { name: 'MaintenanceError' });
  assert.throws(() => registry.getUse(receipt.receipt_id, task), { code: 'reference_unavailable' });
});

test('changed metadata or body prevents adoption of an old successful full read', async () => {
  const { createUsageRegistry } = await import('../plugin/maintenance/usage.js');
  const registry = createUsageRegistry();
  const receipt = registry.registerFullRead(fullRead(), caller);
  for (const changed of [{ ...snapshot(), content: 'changed' }, { ...snapshot(), tags: 'changed' }]) {
    assert.throws(() => registry.declareUse(declaration(receipt), caller, changed), { code: 'snapshot_changed' });
  }
});

test('ambiguous overlapping substrings and normalized lookalikes do not produce invented spans', async () => {
  const { createUsageRegistry } = await import('../plugin/maintenance/usage.js');
  const registry = createUsageRegistry();
  for (const [body, quote] of [['aaa', 'aa'], ['e\u0301', 'é'], ['route', 'missing']]) {
    const record = snapshot(7, body);
    const receipt = registry.registerFullRead(fullRead(record), caller);
    assert.throws(() => registry.declareUse(declaration(receipt, [quote]), caller, record), { code: 'adoption_not_unique' });
  }
});

test('snapshots are detached from caller mutation and no second use replaces the first', async () => {
  const { createUsageRegistry } = await import('../plugin/maintenance/usage.js');
  const registry = createUsageRegistry();
  const read = fullRead();
  const receipt = registry.registerFullRead(read, caller);
  read.snapshot.content = 'tampered';
  const used = registry.declareUse(declaration(receipt), caller, snapshot());
  assert.equal(used.snapshot.content, 'A😀中 route');
  assert.throws(() => registry.declareUse(declaration(receipt), caller, snapshot()), { code: 'already_used' });
});

test('receipt TTL is not refreshed by use and expiry clears retained body bytes', async () => {
  const { createUsageRegistry } = await import('../plugin/maintenance/usage.js');
  let now = 0;
  const registry = createUsageRegistry({ clock: () => now, ttlMs: 10 });
  const receipt = registry.registerFullRead(fullRead(), caller);
  now = 9;
  const used = registry.declareUse(declaration(receipt), caller, snapshot());
  now = 10;
  assert.throws(() => registry.getUse(used.use_id, task), { code: 'reference_unavailable' });
  assert.deepEqual(registry.stats(), { entries: 0, bytes: 0, disposed: false });
});

test('capacity eviction, exact-task cancellation, and dispose clear handles', async () => {
  const { createUsageRegistry } = await import('../plugin/maintenance/usage.js');
  const registry = createUsageRegistry({ capacity: 1 });
  const first = registry.registerFullRead(fullRead(), caller);
  const used = registry.declareUse(declaration(first), caller, snapshot());
  registry.registerFullRead(fullRead(snapshot(8)), caller);
  assert.throws(() => registry.getUse(used.use_id, task), { code: 'reference_unavailable' });
  registry.cancel(task);
  assert.equal(registry.stats().bytes, 0);
  registry.dispose();
  assert.throws(() => registry.getUse(used.use_id, task), { code: 'registry_disposed' });
});

test('byte and statement budgets reject whole observations instead of retaining prefixes', async () => {
  const { createUsageRegistry } = await import('../plugin/maintenance/usage.js');
  const registry = createUsageRegistry({ maxBytes: 2048 });
  assert.throws(() => registry.registerFullRead(fullRead(snapshot(7, '中'.repeat(800))), caller), { code: 'input_budget' });
  assert.equal(registry.stats().entries, 0);
});
