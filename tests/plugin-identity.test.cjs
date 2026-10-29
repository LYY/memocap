const assert = require('node:assert/strict');
const test = require('node:test');
const { receipt, memory, fixture } = require('./plugin-fixture.cjs');

const firstID = `repository:${'a'.repeat(64)}`;
const secondID = `repository:${'b'.repeat(64)}`;
const target = (id, directory = null) => ({ repository_id: id, canonical_path: directory,
  identity_source: directory ? 'directory' : 'selected-id', placements: [id], descriptor: null, observed_at: null });

async function identityHost(resolvedTargets = (targets) => targets) {
  const base = fixture();
  const { createRecallRuntime } = await import('../plugin/recall.js');
  const { createOperations } = await import('../plugin/operations.js');
  const { createTools } = await import('../plugin/tools.js');
  const locations = new Map([[base.input.directory, firstID]]);
  const rows = [];
  const calls = [];
  const runtime = createRecallRuntime(base.input, {}, async (argv, options) => {
    calls.push({ argv, options });
    let targets;
    if (argv.includes('--targets-json')) targets = JSON.parse(argv[argv.indexOf('--targets-json') + 1]);
    else if (argv.includes('--repository-id')) targets = argv.flatMap((arg, index) => arg === '--repository-id' ? [target(argv[index + 1])] : []);
    else targets = argv.flatMap((arg, index) => arg === '--repo' ? [argv[index + 1]] : []).map((directory) => {
      if (!locations.has(directory)) throw Object.assign(new Error('missing explicit path'), { code: 'cli_failed' });
      return target(locations.get(directory), directory);
    });
    const operation = argv[0] === 'scope' && argv[1] === 'resolve' ? 'scope_resolve' : argv[0];
    const envelope = receipt(operation, { targets: operation === 'scope_resolve' ? resolvedTargets(targets) : targets });
    if (operation === 'remember') {
      const entry = memory(rows.length + 1, argv[argv.indexOf('--') + 1]);
      entry.memory.placement = targets[0].repository_id;
      entry.applicable_repositories = [targets[0].repository_id];
      rows.push(entry);
      Object.assign(envelope, { status: 'inserted', returned_ids: [entry.memory.id], searched_placements: [entry.memory.placement] });
    }
    if (['recall', 'list'].includes(operation)) {
      envelope.results = rows.filter((entry) => targets.some((selected) => selected.repository_id === entry.memory.placement));
      envelope.returned_ids = envelope.results.map((entry) => entry.memory.id);
    }
    return { receipt: envelope };
  });
  const tools = createTools(createOperations(runtime));
  const asks = [];
  const context = { sessionID: 'A', messageID: 'identity', abort: new AbortController().signal,
    ask: async (permission) => { asks.push(permission); }, metadata() {} };
  const execute = async (name, args) => JSON.parse((await tools[`memocap_${name}`].execute(args, context)).output);
  return { ...base, runtime, tools, locations, rows, calls, asks, context, execute };
}

test('permission binds frozen ID when path changes during ask, including independent readback', async () => {
  const host = await identityHost();
  host.context.ask = async (permission) => {
    assert.deepEqual(permission.patterns, [firstID]);
    host.locations.set(host.input.directory, secondID);
  };
  const saved = await host.execute('remember', { repository: host.input.directory, content: 'original repository rule' });
  assert.equal(saved.status, 'inserted');
  assert.equal(saved.readback.status, 'ok');
  assert.equal(host.rows[0].memory.placement, firstID);
  assert.deepEqual(host.calls.filter(({ argv }) => ['remember', 'list'].includes(argv[0]))
    .map(({ argv }) => JSON.parse(argv[argv.indexOf('--targets-json') + 1])[0].repository_id), [firstID, firstID]);
});

test('selected IDs survive deleted paths and require permission for new ID-only scopes', async () => {
  const host = await identityHost();
  assert.equal((await host.execute('scope', { paths: [host.input.directory] })).status, 'ok');
  host.locations.clear();
  assert.equal((await host.execute('remember', { content: 'available without checkout' })).readback.status, 'ok');
  assert.deepEqual((await host.execute('recall', { query: 'checkout' })).returned_ids, [1]);
  host.context.ask = async () => { throw new Error('denied'); };
  assert.equal((await host.execute('scope', { repository_ids: [secondID] })).status, 'denied');
  host.context.ask = async () => {};
  assert.deepEqual((await host.execute('recall', { query: 'checkout' })).returned_ids, [1]);
  assert.equal((await host.execute('scope', { repository_ids: [secondID] })).status, 'ok');
  assert.deepEqual((await host.execute('recall', { query: 'checkout' })).returned_ids, []);
});

test('scope boundary rejects empty, duplicate, invalid and mixed selectors before permission', async () => {
  const host = await identityHost();
  for (const args of [{}, { repository_ids: [] }, { repository_ids: [firstID, firstID] },
    { repository_ids: ['repository:bad'] },
    { repository_ids: Array.from({ length: 9 }, (_, index) => `repository:${String(index).repeat(64)}`) },
    { paths: [host.input.directory], repository_ids: [firstID] }, { paths: ['/missing'] }]) {
    assert.equal((await host.execute('scope', args)).status, 'failed', JSON.stringify(args));
  }
  assert.equal(host.asks.length, 0);
});

test('eight explicitly selected IDs can be read but cannot fan out a write or its permission', async () => {
  const host = await identityHost();
  const ids = Array.from({ length: 8 }, (_, index) => `repository:${String(index).repeat(64)}`);
  assert.equal((await host.execute('scope', { repository_ids: ids })).status, 'ok');
  assert.deepEqual(host.asks[0].patterns, ids);
  assert.equal((await host.execute('recall', { query: 'selected' })).status, 'ok');
  const asksBeforeWrite = host.asks.length;
  assert.equal((await host.execute('remember', { content: 'no fanout' })).status, 'failed');
  assert.equal(host.asks.length, asksBeforeWrite);
  assert.equal(host.rows.length, 0);
});

test('distinct checkout paths sharing an ID stay frozen through scope and subsequent recall', async () => {
  const host = await identityHost();
  const paths = [host.input.directory, `${host.input.worktree}-linked`];
  host.locations.set(paths[1], firstID);
  const saved = await host.execute('remember', { content: 'sharedcheckoutanchor' });
  host.context.ask = async (permission) => {
    host.asks.push(permission);
    assert.ok(Object.isFrozen(permission.metadata.targets));
    for (const selected of permission.metadata.targets) {
      assert.ok(Object.isFrozen(selected));
      assert.ok(Object.isFrozen(selected.placements));
    }
    host.locations.set(paths[0], secondID);
    host.locations.set(paths[1], secondID);
  };

  const selected = await host.execute('scope', { paths, query: 'sharedcheckoutanchor' });

  assert.equal(selected.status, 'ok', JSON.stringify(selected));
  const expected = paths.map((directory) => target(firstID, directory));
  assert.deepEqual(selected.targets, expected);
  assert.deepEqual(selected.returned_ids, saved.returned_ids);
  const recalled = await host.execute('recall', { query: 'sharedcheckoutanchor' });
  assert.deepEqual(recalled.targets, expected);
  assert.deepEqual(recalled.returned_ids, saved.returned_ids);
  assert.deepEqual(host.asks.slice(1).map((permission) => permission.metadata.targets), [expected, expected]);
  const asksBeforeWrite = host.asks.length;
  const callsBeforeWrite = host.calls.length;
  assert.equal((await host.execute('remember', { content: 'no fanout' })).status, 'failed');
  assert.equal(host.asks.length, asksBeforeWrite);
  assert.equal(host.calls.length, callsBeforeWrite);
  assert.equal(host.rows.length, 1);
});

test('scope rejects duplicate target paths, duplicate ID-only targets and malformed resolution receipts', async () => {
  for (const resolvedTargets of [
    ([selected]) => [selected, { ...selected }],
    ([selected]) => [selected, { ...selected, repository_id: secondID, placements: [secondID] }],
    () => [target(firstID), target(firstID)],
    ([selected]) => [{ ...selected, repository_id: 'repository:bad' }],
    ([selected]) => [{ ...selected, canonical_path: 42 }],
    ([selected]) => [{ ...selected, placements: [secondID] }],
    ([selected]) => [{ ...selected, descriptor: {} }],
    ([selected]) => [{ ...selected, observed_at: 42 }],
  ]) {
    const host = await identityHost(resolvedTargets);

    const selected = await host.execute('scope', { paths: [host.input.directory] });

    assert.equal(selected.status, 'failed');
    assert.equal(selected.error.code, 'invalid_receipt');
    assert.equal(host.asks.length, 0);
    assert.equal(host.calls.some(({ argv }) => argv[0] === 'recall'), false);
  }
});

test('session invalidation during permission prevents stale target selection', async () => {
  const host = await identityHost();
  host.context.ask = async () => host.runtime.compact({ sessionID: 'A' });
  assert.equal((await host.execute('scope', { repository_ids: [secondID] })).status, 'failed');
  assert.equal(host.calls.some(({ argv }) => argv[0] === 'recall'), false);
});

test('session cancellation during pure resolution cannot inject a stale failure reference', async () => {
  const { createRecallRuntime } = await import('../plugin/recall.js');
  const { user } = require('./plugin-fixture.cjs');
  const base = fixture();
  let started;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const resolving = new Promise((resolve) => { started = resolve; });
  const runtime = createRecallRuntime(base.input, {}, async (argv) => {
    started();
    await pending;
    return base.run(argv, {});
  });
  const message = user();
  const transform = runtime.transform({}, { messages: [message] });
  await resolving;
  await runtime.compact({ sessionID: 'A' });
  release();
  await transform;
  assert.equal(message.parts.length, 1);
});

test('repository context is valid JSON within reference budget even with oversized observations', async () => {
  const { referenceBlock } = await import('../plugin/protocol.js');
  const repository_context = { [firstID]: { identity: null, locations: [
    { canonical_path: '/last-observed', observed_at: '2026-10-29T00:00:00Z', source: 'local' },
  ] } };
  const envelope = receipt('recall', { results: [memory(1, '"\\'.repeat(6000))], returned_ids: [1], repository_context });
  const block = referenceBlock(envelope, {});
  assert.ok(block.text.length <= 6000);
  assert.deepEqual(JSON.parse(block.text.slice(block.text.indexOf('\n') + 1)).repository_context, repository_context);
  repository_context[firstID].locations.push({ canonical_path: 'x'.repeat(12000), observed_at: 'now', source: 'local' });
  const oversized = referenceBlock(envelope, {});
  assert.ok(oversized.text.length <= 6000);
  assert.doesNotThrow(() => JSON.parse(oversized.text.slice(oversized.text.indexOf('\n') + 1)));
});

test('receipt boundary rejects malformed identity context and repository identifiers', async () => {
  const { validateReceipt } = await import('../plugin/protocol.js');
  assert.throws(() => validateReceipt(receipt('recall', { targets: [target('repository:bad')] })), { code: 'invalid_receipt' });
  assert.throws(() => validateReceipt(receipt('recall', { repository_context: {
    [firstID]: { identity: null, locations: [{ canonical_path: '/observed', source: 'local' }] },
  } })), { code: 'invalid_receipt' });
  assert.doesNotThrow(() => validateReceipt(receipt('recall', { targets: [target(firstID)], repository_context: {
    [firstID]: { identity: null, locations: [] },
  } })));
});
