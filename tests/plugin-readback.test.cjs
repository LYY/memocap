const assert = require('node:assert/strict');
const test = require('node:test');
const { accessHost } = require('./plugin-access-fixture.cjs');
const { receipt, memory, user } = require('./plugin-fixture.cjs');
const { createHash } = require('node:crypto');

test('the native exact read tool returns full content and reports a changed reference', async () => {
  const current = await accessHost({ respond: (argv, _settings, answer) => {
    if (argv[0] !== 'read') return answer;
    const row = memory(9, 'current 😀 body');
    row.memory.placement = 'universal';
    return { receipt: receipt('read', { results: [row], returned_ids: [9] }) };
  } });
  const result = await current.execute('read', { id: 9, placement: 'universal', content_hash: 'a'.repeat(64) });
  assert.equal(result.record_changed, true);
  assert.equal(result.results[0].memory.content, 'current 😀 body');
  assert.equal(result.results[0].completeness, 'full');
  assert.equal(result.results[0].content_hash, createHash('sha256').update('current 😀 body').digest('hex'));
  assert.deepEqual(current.asks.map((request) => [request.permission, request.patterns]),
    [['memocap_recall', ['library']], ['memocap_read', ['library']]]);
});

test('remember reconciliation survives new input and tool cancellation after write starts', async () => {
  let current;
  current = await accessHost({ respond: async (argv, settings, answer) => {
    if (argv[0] === 'remember') {
      const message = user('A', 'new-input', 'new task');
      await current.runtime.capture({ sessionID: 'A' }, { message: message.info, parts: message.parts });
      current.abort.abort();
      assert.equal(settings.signal.aborted, false);
      return { receipt: receipt('remember', { status: 'inserted', searched_placements: ['universal'], returned_ids: [11] }) };
    }
    if (argv[0] === 'read') {
      assert.equal(settings.signal.aborted, false);
      const row = memory(11, 'saved once');
      row.memory.placement = 'universal';
      return { receipt: receipt('read', { results: [row], returned_ids: [11] }) };
    }
    return answer;
  } });
  current.abort = new AbortController();
  current.context.abort = current.abort.signal;
  const result = await current.execute('remember', { content: 'saved once', universal: true });
  assert.equal(result.status, 'inserted');
  assert.equal(result.readback.status, 'ok');
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'remember').length, 1);
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'read').length, 1);
});

test('remember does not confirm a matching ID when the stored body differs', async () => {
  const current = await accessHost({ respond: (argv, _settings, answer) => {
    if (argv[0] === 'remember') return { receipt: receipt('remember', {
      status: 'inserted', searched_placements: ['universal'], returned_ids: [11] }) };
    if (argv[0] === 'read') {
      const row = memory(11, 'other concurrent body');
      row.memory.placement = 'universal';
      return { receipt: receipt('read', { results: [row], returned_ids: [11] }) };
    }
    return answer;
  } });
  const result = await current.execute('remember', { content: 'intended body', universal: true });
  assert.equal(result.status, 'inserted');
  assert.equal(result.readback.error.code, 'readback_mismatch');
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'remember').length, 1);
});

test('native remember guards see the same frozen candidate before ask and before commit', async () => {
  const observed = [];
  let candidate;
  const current = await accessHost({ rememberHooks: {
    beforeAsk: async (args, _context, targets) => {
      candidate = args;
      assert.ok(Object.isFrozen(args));
      assert.ok(Object.isFrozen(args.tags));
      assert.ok(Object.isFrozen(targets));
      observed.push('beforeAsk');
    },
    beforeCommit: async (args) => {
      assert.equal(args, candidate);
      observed.push('beforeCommit');
      throw Object.assign(new Error('candidate withdrawn'), { code: 'invalid_request' });
    },
  } });
  current.context.ask = async () => { observed.push('ask'); };
  const result = await current.execute('remember', { content: 'withdrawn', tags: ['guard'] });
  assert.equal(result.status, 'failed');
  assert.deepEqual(observed, ['beforeAsk', 'ask', 'beforeCommit']);
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'remember'), false);
});

test('remember readback stays bound to the requested placement when the commit receipt names another', async () => {
  const current = await accessHost({ respond: (argv, _settings, answer) => {
    if (argv[0] === 'remember') return { receipt: receipt('remember', {
      status: 'inserted', searched_placements: ['domain:other'], returned_ids: [11] }) };
    if (argv[0] === 'read') {
      const row = memory(11, 'intended body');
      row.memory.placement = 'domain:other';
      return { receipt: receipt('read', { results: [row], returned_ids: [11] }) };
    }
    return answer;
  } });
  const result = await current.execute('remember', { content: 'intended body', universal: true });
  assert.equal(result.status, 'inserted');
  assert.equal(result.readback.status, 'failed');
  const reads = current.calls.filter(({ argv }) => argv[0] === 'read');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].argv[reads[0].argv.indexOf('--placement') + 1], 'universal');
});
