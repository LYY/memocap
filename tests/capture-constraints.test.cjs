const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fixture, ref } = require('./capture-pipeline-fixture.cjs');

const restriction = 'Current alpha entry is scripts/alpha-v2 after approval.';
const digest = (content) => createHash('sha256').update(content).digest('hex');
function receipt(content = restriction) {
  return { status: 'ok', operation: 'read', operation_id: 'read_receipt_current', record_changed: false,
    results: [{ completeness: 'full', content_hash: digest(content), memory: { id: 2, placement: 'universal', content } }] };
}
async function deliver(capture, turn, options = {}) {
  const { createTools } = await import('../plugin/tools.js');
  let registered = false;
  const observed = { owns: capture.owns, read(context) {
    const record = capture.read?.(context);
    return (result, args) => { assert.equal(registered, true); record?.(result, args); };
  } };
  const tools = createTools({ targets: async () => [], read: async () => {
    await options.during?.();
    return options.receipt ?? receipt();
  } }, observed, { owns: () => false, registerRead: async (result) => { registered = true; return result; } });
  return tools.memocap_read.execute({ id: 2, placement: 'universal', ...options.args }, {
    sessionID: 'parent', messageID: turn.assistant.id, abort: new AbortController().signal, ...options.context,
  });
}

test('actual full-read callback after maintenance reaches both stages without a used declaration or fact citation', async (t) => {
  const current = await fixture(t, { beforeIdle: async (turn) => { await deliver(turn.capture, turn); } });
  const review = await current.turn('u', 'Remember the independently observed retirement.', [{ text: 'retired-alias was removed.' }]);
  assert.equal(review.detail.metadata.status, 'saved');
  const packets = current.calls.filter((call) => call.packet?.sources).map((call) => call.packet);
  for (const packet of packets) {
    assert.deepEqual(packet.constraints, [{ root_id: 'parent', user_id: 'u', message_id: 'assistant_u',
      id: 2, placement: 'universal', content_hash: digest(restriction), receipt_id: 'read_receipt_current', content: restriction }]);
    assert.equal(packet.sources.some((source) => source.text === restriction), false);
  }
  assert.equal(current.calls.find((call) => call.type === 'write').content.includes(restriction), false);
});

for (const [label, mutate] of [
  ['inconsistent changed flag', (entry) => { entry.record_changed = true; }],
  ['partial', (entry) => { entry.results[0].completeness = 'partial'; }],
  ['hash mismatch', (entry) => { entry.results[0].content_hash = '0'.repeat(64); }],
  ['foreign record', (entry) => { entry.results[0].memory.id = 3; }],
  ['foreign placement', (entry) => { entry.results[0].memory.placement = 'domain:foreign'; }],
  ['missing receipt', (entry) => { delete entry.operation_id; }],
  ['denied', (entry) => { entry.status = 'denied'; }],
  ['secret', (entry) => { const content = 'api_key=sk-ant-' + 'x'.repeat(40); entry.results[0].memory.content = content; entry.results[0].content_hash = digest(content); }],
]) {
  test(`full-read ${label} is discarded before capture retention`, async (t) => {
    const entry = receipt(); mutate(entry);
    const current = await fixture(t, { beforeIdle: async (turn) => { await deliver(turn.capture, turn, { receipt: entry }); } });
    await current.turn('u', 'Keep a durable independently supported preference.');
    assert.deepEqual(current.calls.find((call) => call.packet?.sources).packet.constraints, []);
  });
}

for (const context of [{ sessionID: 'foreign' }, { messageID: 'foreign' }, { abort: AbortSignal.abort() }]) {
  test(`full-read rejects foreign or cancelled caller ${JSON.stringify(context)}`, async (t) => {
    const current = await fixture(t, { beforeIdle: async (turn) => { await deliver(turn.capture, turn, { context }); } });
    await current.turn('u', 'Keep a durable independently supported preference.');
    assert.deepEqual(current.calls.find((call) => call.packet?.sources).packet.constraints, []);
  });
}

test('a full-read started on an older generation cannot attach to the next actual user turn', async (t) => {
  let finish;
  let oldRead;
  const current = await fixture(t, { beforeIdle: async (turn) => {
    if (turn.id === 'u1') {
      const gate = Promise.withResolvers(); finish = gate.resolve;
      const begun = Promise.withResolvers();
      oldRead = deliver(turn.capture, turn, { during: () => { begun.resolve(); return gate.promise; } });
      await begun.promise;
    } else { finish(); await oldRead; }
  } });
  await current.turn('u1', 'Inspect an earlier task.');
  current.options.propose = () => ({ candidates: [] });
  await current.turn('u2', 'A different actual task.');
  assert.deepEqual(current.calls.filter((call) => call.packet?.sources).at(-1).packet.constraints, []);
});

test('constraints cannot supply a forged citation even when they contain the requested new fact', async (t) => {
  const current = await fixture(t, { beforeIdle: async (turn) => { await deliver(turn.capture, turn); }, propose(packet) {
    return { candidates: [{ statements: [{ text: restriction, citations: [{ source_id: packet.constraints[0].receipt_id,
      content_hash: digest(restriction), span: { start: 0, end: [...restriction].length }, quote: restriction }] }] }] };
  } });
  const review = await current.turn('u', 'Inspect replacement inventory.');
  assert.equal(review.detail.metadata.reason, 'evidence_mismatch');
  assert.equal(review.detail.metadata.model_calls, 1);
});

for (const [text, status] of [
  ['scripts/alpha-v2 is the sole approved replacement.', 'skipped'],
  ['Alpha requires two approvers before docs/alpha.md; beta remains excluded.', 'saved'],
]) {
  test(`controlled overall review preserves independent route decisions: ${status}`, async (t) => {
    const current = await fixture(t, { beforeIdle: async (turn) => { await deliver(turn.capture, turn); }, propose(packet) {
      const source = packet.sources.find((entry) => entry.kind === 'file_content');
      return { candidates: [{ kind: 'context', statements: [{ text, citations: [ref(source)] }] }] };
    }, assess(packet, verdict) {
      assert.equal(packet.constraints[0].content, restriction);
      return { ...verdict, memory: { status: status === 'saved' ? 'accept' : 'reject' } };
    } });
    const review = await current.turn('u', 'Inspect the independently verified route.', [{ text }]);
    assert.equal(review.detail.metadata.status, status);
    assert.equal(review.detail.metadata.model_calls, status === 'saved' ? 3 : 2);
    assert.equal(review.detail.metadata.write_attempts, status === 'saved' ? 1 : 0);
  });
}

test('constraints reserve selected input units rather than hiding extra memory dependencies', async (t) => {
  const current = await fixture(t, { beforeIdle: async (turn) => {
    for (let id = 1; id <= 11; id++) {
      const entry = receipt(`Restriction ${id}: approval required.`);
      entry.results[0].memory.id = id; entry.operation_id = `receipt_${id}`;
      await deliver(turn.capture, turn, { receipt: entry, args: { id } });
    }
  } });
  await current.turn('u', 'Inspect alpha release.', Array.from({ length: 4 }, () => ({ text: 'Approval required. Never use for beta.' })));
  const packet = current.calls.find((call) => call.packet?.sources).packet;
  assert.equal(packet.constraints.length, 11);
  assert.equal(packet.bundles.reduce((count, bundle) => count + bundle.units.length, 0) + packet.constraints.length, 12);
});

test('overbudget full-read content blocks the turn without retaining a prefix', async (t) => {
  const current = await fixture(t, { beforeIdle: async (turn) => { await deliver(turn.capture, turn, { receipt: receipt('x'.repeat(9000)) }); } });
  const review = await current.turn('u', 'Keep a durable preference.');
  assert.equal(review.detail.metadata.model_calls, 0);
  assert.equal(current.calls.some((call) => call.type === 'write'), false);
});

test('a changed full-read of the same record invalidates its earlier current-turn restriction', async (t) => {
  const current = await fixture(t, { beforeIdle: async (turn) => {
    await deliver(turn.capture, turn);
    await deliver(turn.capture, turn, { receipt: receipt('Current alpha entry requires two approvers.') });
  } });
  const review = await current.turn('u', 'Keep a durable preference.');
  assert.equal(review.detail.metadata.model_calls, 0);
});

test('a valid changed reference retains the independently hashed current full body', async (t) => {
  const entry = { ...receipt(), record_changed: true };
  const current = await fixture(t, { beforeIdle: (turn) => deliver(turn.capture, turn,
    { receipt: entry, args: { content_hash: digest('An older reference.') } }) });
  const review = await current.turn('u', 'Keep an independently supported preference.');
  assert.equal(review.detail.metadata.status, 'saved');
  for (const call of current.calls.filter((call) => call.packet?.sources)) {
    assert.equal(call.packet.constraints[0]?.content, restriction);
    assert.equal(call.packet.constraints[0]?.content_hash, digest(restriction));
  }
});

test('a valid changed full read invalidates an earlier permissive same-record dependency', async (t) => {
  const current = await fixture(t, { beforeIdle: async (turn) => {
    await deliver(turn.capture, turn);
    await deliver(turn.capture, turn, { receipt: { ...receipt('Alpha requires two independent approvals.'), record_changed: true },
      args: { content_hash: digest(restriction) } });
  } });
  const review = await current.turn('u', 'Keep an independently supported preference.');
  assert.equal(review.detail.metadata.model_calls, 0);
  assert.equal(current.calls.some((call) => call.type === 'write'), false);
});

test('a full read already in flight invalidates frozen currency when it completes during permission', async (t) => {
  const gate = Promise.withResolvers();
  const begun = Promise.withResolvers();
  let pending;
  const current = await fixture(t, { beforeIdle: async (turn) => {
    await deliver(turn.capture, turn);
    pending = deliver(turn.capture, turn, { during: () => { begun.resolve(); return gate.promise; }, receipt: receipt('Alpha requires two approvals.') });
    await begun.promise;
  }, beforeAsk: async () => { gate.resolve(); await pending; } });
  const review = await current.turn('u', 'Keep an independently supported preference.');
  assert.equal(review.detail.metadata.reason, 'new_input');
  assert.equal(review.detail.metadata.write_attempts, 0);
  assert.equal(current.calls.some((call) => call.type === 'write'), false);
});

test('an originally aborted read cannot change frozen currency during permission', async (t) => {
  const gate = Promise.withResolvers();
  const begun = Promise.withResolvers();
  const controller = new AbortController();
  let pending;
  const current = await fixture(t, { beforeIdle: async (turn) => {
    await deliver(turn.capture, turn);
    pending = deliver(turn.capture, turn, { context: { abort: controller.signal },
      during: () => { begun.resolve(); return gate.promise; }, receipt: receipt('Alpha requires two approvals.') });
    await begun.promise;
  }, beforeAsk: async () => { controller.abort(); gate.resolve(); await pending; } });
  const review = await current.turn('u', 'Keep an independently supported preference.');
  assert.equal(review.detail.metadata.status, 'saved');
  assert.equal(current.calls.filter((call) => call.type === 'write').length, 1);
});

for (const phase of ['beforeSpawn', 'afterSpawn']) {
  for (const unknown of phase === 'afterSpawn' ? [false, true] : [false]) {
    test(`a captured full-read completion respects the write boundary at ${phase} (${unknown})`, async (t) => {
      let record;
      const current = await fixture(t, { unknown, beforeIdle: async (turn) => {
        await deliver(turn.capture, turn);
        record = turn.capture.read({ sessionID: 'parent', messageID: turn.assistant.id, abort: new AbortController().signal });
      }, [phase]: () => record(receipt('Alpha requires two approvals.'), { id: 2, placement: 'universal' }) });
      const review = await current.turn('u', 'Keep an independently supported preference.');
      assert.equal(review.detail.metadata.write_attempts, phase === 'beforeSpawn' ? 0 : 1);
      assert.equal(review.detail.metadata.status, phase === 'beforeSpawn' ? 'skipped' : unknown ? 'unknown' : 'saved');
      assert.equal(current.calls.filter((call) => call.type === 'readback').length, phase === 'beforeSpawn' ? 0 : 1);
    });
  }
}

test('full-read callback binds the observed caller before asynchronous tool work can mutate context', async (t) => {
  const current = await fixture(t, { beforeIdle(turn) {
    const context = { sessionID: 'parent', messageID: turn.assistant.id, abort: new AbortController().signal };
    const record = turn.capture.read(context);
    context.sessionID = 'foreign'; context.messageID = 'foreign';
    record(receipt(), { id: 2, placement: 'universal' });
  } });
  await current.turn('u', 'Keep an independently supported preference.');
  assert.equal(current.calls.find((call) => call.packet?.sources).packet.constraints[0]?.message_id, 'assistant_u');
});

test('full-read callback keeps the original cancellation signal when context is later replaced', async (t) => {
  const current = await fixture(t, { beforeIdle(turn) {
    const controller = new AbortController();
    const context = { sessionID: 'parent', messageID: turn.assistant.id, abort: controller.signal };
    const record = turn.capture.read(context);
    controller.abort(); context.abort = new AbortController().signal;
    record(receipt(), { id: 2, placement: 'universal' });
  } });
  await current.turn('u', 'Keep an independently supported preference.');
  assert.deepEqual(current.calls.find((call) => call.packet?.sources).packet.constraints, []);
});
