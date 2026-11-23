const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, ref } = require('./capture-pipeline-fixture.cjs');
const { createHash } = require('node:crypto');

for (const timing of ['saved-before-finish', 'finalized']) for (const type of ['session.error', 'session.deleted']) {
  test(`${timing} child ${type} retains substantive T1 evidence for T3 support`, async (t) => {
    const route = 'Quartz😀 jobs enter through jobs/start; approval is required before submission.';
    const verified = 'GET Quartz job 42: completed; result checksum verified.';
    const finalized = Promise.withResolvers();
    const signal = (capture, id) => capture.event({ event: { type, properties: { sessionID: id } } });
    const current = await fixture(t, { onReview: finalized.resolve, afterExecute: timing === 'saved-before-finish' ? signal : undefined, propose(packet) {
      const old = packet.sources.find((source) => source.user_id === 't1' && source.kind === 'file_content');
      const fresh = packet.sources.find((source) => source.user_id === 't3' && source.kind === 'command_result');
      if (packet.current_user_id === 't2') return { candidates: [] };
      const citations = fresh && old ? [ref(old), ref(fresh)] : [ref(old ?? packet.sources.find((source) => source.user_id === packet.current_user_id))];
      return { candidates: [{ statements: [{ text: fresh ? 'Quartz jobs use jobs/start with approval and independent result verification.' : 'Quartz job submission requires approval.', citations }] }] };
    } });
    const first = await current.turn('t1', 'Find the Quartz job entry and its approval condition.', [{ text: route }]);
    await finalized.promise;
    assert.equal(first.detail.metadata.status, 'saved');
    assert.deepEqual(current.calls.filter(({ type }) => ['write', 'readback'].includes(type)).map(({ type }) => type), ['write', 'readback']);
    const before = current.calls.length;
    if (timing === 'finalized') signal(current.capture, current.calls.find((call) => call.type === 'child' && call.stage === 'commit').id);
    assert.equal(current.calls.length, before);
    await current.turn('t2', 'Continue the same Quartz job 42 after approval.', [{ kind: 'command', text: 'Quartz job 42 queued after approval.' }]);
    const third = await current.turn('t3', 'Verify that same Quartz job 42 result.', [{ kind: 'command', text: verified }]);
    const packets = current.calls.filter((call) => call.type === 'generation' && call.packet.current_user_id === 't3').map((call) => call.packet);
    for (const packet of packets) for (const text of [route, verified]) {
      const hash = createHash('sha256').update(text).digest('hex');
      const source = packet.sources.find((source) => source.content_hash === hash);
      assert.ok(source, `T3 ${packet.candidate ? 'support' : 'extraction'} lost substantive source ${hash}`);
      assert.deepEqual(source.span, { start: 0, end: [...text].length });
      if (packet.candidate) assert.ok(packet.candidate.statements[0].citations.some((citation) => citation.content_hash === hash && citation.span.start === 0 && citation.span.end === [...text].length));
    }
    assert.equal(packets.length, 2);
    assert.equal(third.detail.metadata.status, 'saved');
    assert.ok(current.reviews.every(({ detail }) => detail.metadata.model_calls <= 3 && detail.metadata.write_attempts <= 1));
    assert.equal(current.calls.filter((call) => call.type === 'generation').length, 7);
    assert.equal(current.calls.filter((call) => call.type === 'write').length, 2);
  });
}

for (const type of ['session.error', 'session.deleted']) for (const boundary of ['active', 'writing-unverified', 'parent']) {
  test(`${boundary} ${type} still evicts unresolved evidence`, async (t) => {
    const current = await fixture(t);
    const signal = () => current.capture.event({ event: { type, properties: { sessionID: boundary === 'parent' ? 'parent' : current.calls.find((call) => call.type === 'child' && call.stage === 'commit').id } } });
    if (boundary === 'active') current.options.beforeAsk = signal;
    if (boundary === 'writing-unverified') current.options.afterSpawn = signal;
    const first = await current.turn('t1', 'Find the Quartz entry.', [{ text: 'Quartz jobs require approval at jobs/start.' }]);
    if (boundary === 'parent') signal();
    if (boundary === 'active') { assert.equal(first.detail.metadata.reason, 'worker_signal'); assert.equal(first.detail.metadata.write_attempts, 0); }
    delete current.options.beforeAsk; delete current.options.afterSpawn;
    current.options.propose = (packet) => { assert.equal(packet.sources.every((source) => source.user_id === 't2'), true); return { candidates: [] }; };
    assert.equal((await current.turn('t2', 'Continue the same Quartz job.')).detail.metadata.reason, 'no_candidate');
    assert.equal(current.calls.filter((call) => call.type === 'write').length, boundary === 'active' ? 0 : 1);
  });
}

test('new real input and a late closed child event cannot revive its stale candidate or write', async (t) => {
  const current = await fixture(t, { beforeAsk: () => current.capture.observe({ sessionID: 'parent', agent: 'build' },
    { message: { id: 'new', role: 'user' }, parts: [{ id: 'new_text', type: 'text', text: 'Continue Quartz with new instructions.' }] }) });
  const first = await current.turn('old', 'Use the Quartz approval route.');
  assert.equal(first.detail.metadata.reason, 'new_input');
  const child = current.calls.find((call) => call.type === 'child' && call.stage === 'commit').id;
  current.capture.event({ event: { type: 'session.error', properties: { sessionID: child } } });
  assert.throws(() => current.capture.params({ sessionID: child }, {}), { code: 'worker_closed' });
  delete current.options.beforeAsk; current.options.propose = () => ({ candidates: [] });
  assert.equal((await current.turn('fresh', 'Verify the same Quartz job.')).detail.metadata.reason, 'no_candidate');
  assert.equal(current.calls.some((call) => call.type === 'write'), false);
});

test('terminal observer rejection preserves the independently read-back capture without a replay', async (t) => {
  const done = Promise.withResolvers();
  const current = await fixture(t, { onReview: done.resolve, onLifecycle: async (event) => {
    if (event.phase === 'review.finished') throw new Error('terminal sink rejected');
  } });
  await current.turn('u', 'Use concise Chinese when responding in future.');
  const summary = await done.promise;
  assert.equal(summary.status, 'saved'); assert.equal(summary.observation_warning, 'capture_observation_failed');
  assert.equal(summary.write_attempts, 1);
  assert.deepEqual(current.calls.filter(({ type }) => ['write', 'readback'].includes(type)).map(({ type }) => type), ['write', 'readback']);
});

for (const [label, omitSessionPermission] of [['present', false], ['omitted', true]]) {
  test(`public capture synthesizes, independently supports, commits once and blocks actual fourth admission (session permission ${label})`, async (t) => {
    const current = await fixture(t, { omitSessionPermission });
    const review = await current.turn('u', 'Use concise Chinese when responding in future.');
    assert.equal(review.detail.metadata.status, 'saved', review.detail.metadata.reason);
    assert.equal(review.detail.metadata.model_calls, 3);
    assert.equal(current.calls.filter((call) => call.type === 'generation').length, 3);
    assert.deepEqual(current.calls.filter((call) => call.type === 'child').map((call) => call.stage), ['extract', 'commit']);
    assert.deepEqual(current.calls.filter((call) => call.type === 'blocked').map((call) => call.code), ['model_budget']);
    assert.deepEqual(current.calls.filter((call) => ['ask', 'write', 'readback'].includes(call.type)).map((call) => call.type), ['ask', 'write', 'readback']);
    assert.equal(current.calls.some((call) => call.type === 'history' && call.id === 'parent'), false);
  });
}

for (const status of ['unknown', 'unsupported']) {
  test(`public capture rejects ${status} support without commit child or repair`, async (t) => {
    const current = await fixture(t, { support: status });
    const review = await current.turn('u', 'Use concise Chinese when responding in future.');
    assert.equal(review.detail.metadata.reason, 'unsupported');
    assert.equal(review.detail.metadata.model_calls, 2);
    assert.equal(current.calls.filter((call) => call.type === 'child').length, 1);
    assert.equal(current.calls.some((call) => call.type === 'write'), false);
  });
}

test('full contextual tail survives selection and support sees every condition with Unicode spans', async (t) => {
  const text = `# Alpha😀\n\nUse entry.md after approval.\n${'Bounded guidance. '.repeat(90)}\n## Restrictions\nNever use for beta; require a verified GET business result.`;
  const current = await fixture(t, { support: 'unsupported', propose: (packet) => {
    const source = packet.sources.find((entry) => entry.kind === 'file_content');
    const citation = { ...ref(source), span: { start: 0, end: 8 }, quote: [...source.text].slice(0, 8).join('') };
    return { candidates: [{ statements: [{ text: 'Alpha is available.', citations: [citation] }] }] };
  } });
  const review = await current.turn('u', 'Read Alpha😀 guidance before reusing entry.md.', [{ text }]);
  assert.equal(review.detail.metadata.reason, 'unsupported');
  const generation = current.calls.filter((call) => call.type === 'generation')[1];
  assert.equal(generation.packet.bundles.flatMap((bundle) => bundle.units).some((unit) => unit.text.includes('Never use for beta')), true);
});

test('T1 route and T2 queued remain evidence until T3 independent GET verification with exact cross-turn citations', async (t) => {
  const current = await fixture(t, { propose: (packet) => {
    const old = packet.sources.find((source) => source.user_id === 't1' && source.kind === 'file_content');
    const fresh = packet.sources.find((source) => source.user_id === 't3' && source.kind === 'command_result');
    if (!fresh) return { candidates: [] };
    assert.ok(old);
    return { candidates: [{ statements: [{ text: 'Alpha job 42 completed after verification; approval remains required.', citations: [ref(old), ref(fresh)] }] }] };
  } });
  await current.turn('t1', 'Find the alpha job route.', [{ text: 'Alpha jobs require approval.' }]);
  await current.turn('t2', 'Continue alpha job 42.', [{ kind: 'command', text: 'alpha job 42 queued' }]);
  const result = await current.turn('t3', 'Verify the same alpha job 42.', [{ kind: 'command', text: 'GET alpha job 42: completed, result verified' }]);
  assert.equal(result.detail.metadata.status, 'saved');
  const packet = current.calls.filter((call) => call.type === 'generation').at(-2).packet;
  assert.deepEqual(packet.candidate.statements[0].citations.map((citation) => packet.sources.find((source) => source.source_id === citation.source_id).user_id), ['t1', 't3']);
});

for (const status of ['unknown', 'new_task', 'changed']) {
  test(`${status} continuity clears previous task evidence before the next review`, async (t) => {
    let step = 0;
    const current = await fixture(t, { continuity: status, propose: (packet) => {
      step++;
      if (step === 1) return { candidates: [] };
      if (step === 3) {
        assert.equal(packet.sources.every((source) => source.user_id === 't3'), true);
        return { candidates: [] };
      }
      const prior = packet.sources.find((source) => source.user_id === 't1');
      const fresh = packet.sources.find((source) => source.user_id === 't2');
      return { candidates: [{ statements: [{ text: 'Alpha continuity is verified.', citations: [ref(prior), ref(fresh)] }] }] };
    } });
    await current.turn('t1', 'Find alpha route.');
    const result = await current.turn('t2', 'Continue alpha in another environment.');
    assert.equal(result.detail.metadata.reason, 'continuity_unknown');
    await current.turn('t3', 'Verify alpha later.');
    assert.equal(current.calls.some((call) => call.type === 'write'), false);
  });
}

test('changed frozen origin excludes old evidence without forging user identity', async (t) => {
  const current = await fixture(t, { propose: (packet) => {
    if (packet.current_user_id === 't2') assert.equal(packet.sources.every((source) => source.user_id === 't2'), true);
    return { candidates: [] };
  } });
  await current.turn('t1', 'Find alpha route.');
  current.state('parent').targets = [{ repository_id: 'repository:different' }];
  await current.turn('t2', 'Continue alpha route.');
});

test('current-only citations retain all selected prior context for overall admission', async (t) => {
  const current = await fixture(t, { propose: (packet) => {
    if (packet.current_user_id === 't1') return { candidates: [] };
    assert.ok(packet.sources.some((source) => source.user_id === 't1'));
    const source = packet.sources.find((entry) => entry.user_id === 't2');
    return { candidates: [{ statements: [{ text: 'Prefer concise alpha summaries.', citations: [ref(source)] }] }] };
  } });
  await current.turn('t1', 'Find alpha deployment route.');
  await current.turn('t2', 'For alpha summaries, prefer concise text.');
  const support = current.calls.filter((call) => call.type === 'generation' && call.packet.candidate).at(-1).packet;
  assert.ok(support.sources.some((source) => source.user_id === 't1'));
  assert.ok(support.bundles.some((bundle) => bundle.user_id === 't1'));
});

test('support receives only model citations and the immutable body reused through issuance and commit', async (t) => {
  const decisions = [];
  const current = await fixture(t, { onDecision: (event) => decisions.push(event), assess(packet, verdict) {
    assert.deepEqual(Object.keys(packet.candidate).sort(), ['statements']);
    assert.deepEqual(Object.keys(packet.candidate.statements[0].citations[0]).sort(), ['content_hash', 'quote', 'source_id', 'span']);
    assert.equal(typeof packet.persisted_body, 'string');
    return verdict;
  } });
  const review = await current.turn('u', 'Use concise Chinese when responding in future.');
  assert.equal(review.detail.metadata.status, 'saved');
  const supported = current.calls.find((call) => call.packet?.persisted_body).packet.persisted_body;
  assert.equal(current.calls.find((call) => call.type === 'write').content, supported);
  const identity = decisions.find((event) => event.stage === 'identity').identity;
  const issued = decisions.find((event) => event.stage === 'issuance').candidate;
  assert.equal(identity.body, supported);
  assert.equal(issued.body, supported);
  assert.equal(Object.isFrozen(issued.statements[0].citations[0].pointer), true);
});

for (const [label, source, statement] of [
  ['whole runbook', '# Alpha release\nApproval required. Never use for beta.\n1. Start at scripts/alpha-release.\n2. Verify mock://quartz/health before finishing.', null],
  ['status-only q2', 'GET q2: completed; healthy; environment=alpha', 'The alpha rehearsal q2 is completed and healthy.'],
  ['a durable restriction mixed with a current-session directive', 'Alpha imports always require approval. Hold this import until the sample count is confirmed.', null],
]) {
  test(`overall admission can reject ${label} despite supported atoms without another generation`, async (t) => {
    const current = await fixture(t, { memory: 'reject', propose(packet) {
      const selected = packet.sources.find((entry) => entry.kind === 'file_content');
      return { candidates: [{ kind: 'context', statements: [{ text: statement ?? source, citations: [ref(selected)] }] }] };
    } });
    const review = await current.turn('u', 'Review the alpha route.', [{ text: source }]);
    assert.equal(review.detail.metadata.reason, 'memory_rejected');
    assert.equal(review.detail.metadata.model_calls, 2);
    assert.equal(current.calls.some((call) => call.type === 'write'), false);
    const packet = current.calls.filter((call) => call.type === 'generation')[1].packet;
    assert.equal(packet.persisted_body.startsWith(statement ?? source), true);
    const footer = JSON.parse(packet.persisted_body.split('\n\nCapture sources: ')[1]);
    assert.equal(footer.citations[0].fragment, true);
    assert.equal(footer.citations[0].excerpt, [...packet.candidate.statements[0].citations[0].quote].slice(0, 32).join(''));
  });
}

test('source reclassification after asynchronous guard is rechecked synchronously before native spawn', async (t) => {
  const current = await fixture(t, { beforeSpawn: (capture) => capture.event({ event: { type: 'message.part.updated', properties: {
    part: { id: 'text_u', sessionID: 'parent', messageID: 'u', type: 'text', text: 'Use concise Chinese.', synthetic: true },
  } } }) });
  const result = await current.turn('u', 'Use concise Chinese.');
  assert.equal(result.detail.metadata.reason, 'source_changed');
  assert.equal(result.detail.metadata.write_attempts, 0);
});

test('late secret metadata revokes whole source even when the selected quote was clean', async (t) => {
  const current = await fixture(t, { propose: (packet) => {
    assert.equal(packet.sources.some((source) => source.kind === 'file_content'), false);
    return { candidates: [] };
  } });
  await current.turn('u', 'Read alpha route.', [{ text: 'Alpha route requires approval.', change: (part) => { part.state.metadata.hidden = 'api_key=synthetic-value'; } }]);
  assert.equal(current.calls.some((call) => call.type === 'write'), false);
});

test('coordinator runs once, skips extraction on false and excludes owned maintenance children', async (t) => {
  let calls = 0;
  const current = await fixture(t, { coordinator: { owns: (id) => id === 'maintenance', beforeReview: async () => { calls++; return false; } } });
  assert.equal(current.capture.owns('maintenance'), true);
  const review = await current.turn('u', 'Use concise Chinese.');
  assert.equal(calls, 1);
  assert.equal(review.detail.metadata.reason, 'coordinator_cancelled');
  assert.equal(current.calls.length, 0);
});

for (const unknown of [false, true]) {
  test(`after-start cancellation preserves independent readback and never replays (${unknown})`, async (t) => {
    const current = await fixture(t, { unknown, afterSpawn: (capture) => capture.event({ event: { type: 'session.status', properties: { sessionID: 'parent', status: { type: 'idle' } } } }) });
    const review = await current.turn('u', 'Use concise Chinese.');
    assert.equal(review.detail.metadata.status, unknown ? 'unknown' : 'saved');
    assert.equal(current.calls.filter((call) => call.type === 'write').length, 1);
    assert.equal(current.calls.filter((call) => call.type === 'readback').length, 1);
  });
}
