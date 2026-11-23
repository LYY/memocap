const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, ref } = require('./capture-pipeline-fixture.cjs');
const { createHash } = require('node:crypto');

test('full rendered body overflow stops before support rather than truncating or repairing', async (t) => {
  const current = await fixture(t, { statement: 'A'.repeat(1190) });
  const review = await current.turn('u', 'Keep this durable preference.');
  assert.equal(review.detail.metadata.reason, 'body_budget');
  assert.equal(review.detail.metadata.model_calls, 1);
  assert.equal(current.calls.find((call) => call.type === 'generation').packet.body_budget?.version, 1);
  assert.equal(current.calls.some((call) => call.type === 'write'), false);
});

test('body budget rejection retains full T1 route for a freshly supported three-claim T3 memory', async (t) => {
  const route = 'Quartz😀 alpha jobs enter through jobs/start; approval is required before submission; never use this route for beta.';
  const verified = 'GET Quartz alpha job 42: completed; result checksum independently verified after approved submission.';
  const claims = ['Quartz alpha jobs use jobs/start.', 'Approval is required before submission; never use this route for beta.',
    'Independently verify the completed job result checksum after submission.'];
  const decisions = [];
  const current = await fixture(t, { onDecision: (event) => decisions.push(event), propose(packet) {
    if (packet.current_user_id === 't1') return { candidates: [] };
    if (packet.current_user_id === 't2') return { candidates: [{ statements: [{ text: 'A'.repeat(1190),
      citations: [ref(packet.sources.find((source) => source.user_id === 't2'))] }] }] };
    const prior = packet.sources.find((source) => source.user_id === 't1' && source.text === route);
    const fresh = packet.sources.find((source) => source.user_id === 't3' && source.text === verified);
    assert.ok(prior, 'T3 extraction lost the clean T1 route after body_budget');
    assert.ok(fresh);
    return { candidates: [{ statements: claims.map((text, index) => ({ text, citations: [ref(index < 2 ? prior : fresh)] })) }] };
  } });
  assert.equal((await current.turn('t1', 'Find the Quartz alpha job route and its restrictions.', [{ text: route }])).detail.metadata.reason, 'no_candidate');
  const second = await current.turn('t2', 'Continue the same Quartz alpha job 42 after approval.', [{ kind: 'command', text: 'Quartz alpha job 42 queued after approval.' }]);
  assert.equal(second.detail.metadata.status, 'skipped');
  assert.equal(second.detail.metadata.reason, 'body_budget');
  assert.equal(second.detail.metadata.model_calls, 1);
  assert.equal(second.detail.metadata.write_attempts, 0);
  assert.equal(current.calls.some((call) => call.type === 'write'), false);
  const third = await current.turn('t3', 'Independently verify the same Quartz alpha job 42 result.', [{ kind: 'command', text: verified }]);
  const packets = current.calls.filter((call) => call.type === 'generation' && call.packet.current_user_id === 't3').map((call) => call.packet);
  assert.ok(packets[0].sources.some((source) => source.user_id === 't1' && source.text === route), 'T3 extraction lost the clean T1 route after body_budget');
  assert.equal(third.detail.metadata.status, 'saved', third.detail.metadata.reason);
  assert.equal(packets.length, 2);
  for (const packet of packets) for (const text of [route, verified]) {
    const hash = createHash('sha256').update(text).digest('hex');
    const source = packet.sources.find((source) => source.content_hash === hash);
    assert.equal(source?.text, text);
    assert.deepEqual(source.span, { start: 0, end: [...text].length });
    if (packet.candidate) assert.ok(packet.candidate.statements.flatMap((statement) => statement.citations).some((citation) =>
      citation.content_hash === hash && citation.quote === text && citation.span.start === 0 && citation.span.end === [...text].length));
  }
  const supported = decisions.find((event) => event.user_id === 't3' && event.stage === 'support_raw').raw;
  assert.equal(supported.continuity.status, 'supported');
  assert.deepEqual(supported.statements.map(({ status }) => status), ['supported', 'supported', 'supported']);
  assert.deepEqual(current.calls.filter(({ type }) => ['write', 'readback'].includes(type)).map(({ type }) => type), ['write', 'readback']);
  const body = current.calls.find((call) => call.type === 'write').content;
  assert.equal(body, packets[1].persisted_body);
  assert.equal(body.split('\n\nCapture sources: ')[0], claims.join('\n\n'));
  assert.equal(current.calls.filter((call) => call.type === 'generation').length, 5);
  assert.equal(third.detail.metadata.model_calls, 3);
  assert.equal(third.detail.metadata.write_attempts, 1);
  current.capture.event({ event: { type: 'session.status', properties: { sessionID: 'parent', status: { type: 'idle' } } } });
  assert.equal(current.calls.filter((call) => call.type === 'generation').length, 5);
  assert.equal(current.calls.filter((call) => call.type === 'write').length, 1);
});

test('prior-only refusal preserves T1 evidence for a fresh T3 capture with verified readback', async (t) => {
  const route = 'Quartz alpha jobs enter through jobs/start and require approval before submission.';
  const verification = 'GET Quartz alpha job 42: completed; result checksum independently verified.';
  const current = await fixture(t, { propose(packet) {
    if (packet.current_user_id === 't1') return { candidates: [] };
    const prior = packet.sources.find((source) => source.user_id === 't1' && source.text === route);
    if (!prior) return { candidates: [] };
    if (packet.current_user_id === 't2') return { candidates: [{ statements: [{ text: route, citations: [ref(prior)] }] }] };
    const fresh = packet.sources.find((source) => source.user_id === 't3' && source.text === verification);
    return { candidates: [{ statements: [{ text: 'Submit approved Quartz alpha jobs through jobs/start, then independently verify the result checksum.',
      citations: [ref(prior), ref(fresh)] }] }] };
  } });

  const first = await current.turn('t1', 'Find the Quartz alpha job route.', [{ text: route }]);
  assert.equal(first.detail.metadata.reason, 'no_candidate');
  const second = await current.turn('t2', 'Continue the same Quartz alpha job 42.', [{ kind: 'command', text: 'Quartz alpha job 42 queued after approval.' }]);
  assert.equal(second.detail.metadata.status, 'skipped');
  assert.equal(second.detail.metadata.reason, 'current_evidence_required');
  assert.equal(second.detail.metadata.model_calls, 1);
  assert.equal(second.detail.metadata.write_attempts, 0);
  assert.deepEqual(current.calls.filter(({ type }) => ['write', 'readback'].includes(type)), []);

  const third = await current.turn('t3', 'Independently verify the same Quartz alpha job 42.', [{ kind: 'command', text: verification }]);
  const extraction = current.calls.find((call) => call.type === 'generation' && call.packet.current_user_id === 't3').packet;
  assert.ok(extraction.sources.some((source) => source.user_id === 't1' && source.text === route),
    'T3 extraction lost the T1 route after current_evidence_required');
  assert.equal(third.detail.metadata.status, 'saved', third.detail.metadata.reason);
  assert.equal(third.detail.metadata.reason, 'saved_verified');
  assert.deepEqual(third.detail.metadata.memory_ids, [1]);
  assert.deepEqual(current.calls.filter(({ type }) => ['write', 'readback'].includes(type)).map(({ type }) => type), ['write', 'readback']);
});

for (const [scenario, alterVerdict, preserve] of [
  ['matching mixed witness', (verdict) => verdict, true],
  ['wrong witness', (verdict) => ({ ...verdict, continuity: { ...verdict.continuity, witness_id: '0'.repeat(64) } }), false],
  ['ambiguous continuity', (verdict) => ({ ...verdict, continuity: { status: 'unknown' } }), false],
  ['current-only candidate with a standalone witness', (verdict) => verdict, false],
  ['unknown memory disposition', (verdict) => ({ ...verdict, memory: { status: 'unknown' } }), false],
  ['extra continuity field', (verdict) => ({ ...verdict, continuity: { ...verdict.continuity, extra: true } }), false],
]) {
  test(`skipped capture ${preserve ? 'preserves' : 'breaks'} observed continuity: ${scenario}`, async (t) => {
    const route = 'For Cedar sample exports, use cedar/export with the lab profile only; never use the field profile.';
    const queued = 'The Cedar lab sample export has been queued.';
    const verified = 'Cedar lab export completed; the manifest record count matched the source inventory.';
    const claims = [route, 'After the Cedar lab export completes, compare the manifest record count with the source inventory.'];
    const current = await fixture(t, { propose(packet) {
      if (packet.current_user_id === 't1') return { candidates: [] };
      const prior = packet.sources.find((source) => source.user_id === 't1' && source.text === route);
      if (!prior) return { candidates: [] };
      if (packet.current_user_id === 't2') {
        const progress = packet.sources.find((source) => source.user_id === 't2' && source.text === queued);
        const citations = scenario === 'current-only candidate with a standalone witness' ? [ref(progress)] : [ref(prior), ref(progress)];
        return { candidates: [{ statements: [{ text: queued, citations }] }] };
      }
      const fresh = packet.sources.find((source) => source.user_id === 't3' && source.text === verified);
      return { candidates: [{ statements: [{ text: claims[0], citations: [ref(prior)] },
        { text: claims[1], citations: [ref(fresh)] }] }] };
    }, assess(packet, verdict) {
      return packet.current_user_id === 't2' ? alterVerdict({ ...verdict, memory: { status: 'reject' } }) : verdict;
    } });

    await current.turn('t1', 'Find the Cedar sample export procedure.', [{ text: route }]);
    const second = await current.turn('t2', 'Start that Cedar lab export.', [{ kind: 'command', text: queued }]);
    assert.equal(second.detail.metadata.status, 'skipped');
    assert.equal(second.detail.metadata.reason, 'memory_rejected');
    assert.equal(second.detail.metadata.model_calls, 2);
    assert.equal(second.detail.metadata.write_attempts, 0);
    assert.deepEqual(current.calls.filter(({ type }) => ['ask', 'write', 'readback'].includes(type)), []);

    const third = await current.turn('t3', 'Verify that Cedar lab export against the source inventory.', [{ kind: 'command', text: verified }]);
    const extraction = current.calls.find(({ type, packet }) => type === 'generation' && packet.current_user_id === 't3').packet;
    assert.equal(extraction.sources.some((source) => source.user_id === 't1' && source.text === route), preserve,
      'T3 extraction must retain the original T1 route only after an explicit rejection with validated mixed support');
    const nativeCalls = current.calls.filter(({ type }) => ['ask', 'write', 'readback'].includes(type));
    if (!preserve) {
      assert.deepEqual([...new Set(extraction.sources.map(({ user_id }) => user_id))], ['t3']);
      assert.equal(third.detail.metadata.reason, 'no_candidate');
      assert.deepEqual(nativeCalls, []);
      return;
    }
    assert.equal(third.detail.metadata.reason, 'saved_verified');
    assert.deepEqual(third.detail.metadata.memory_ids, [1]);
    assert.equal(third.detail.metadata.model_calls, 3);
    assert.equal(third.detail.metadata.write_attempts, 1);
    assert.deepEqual(nativeCalls.map(({ type }) => type), ['ask', 'write', 'readback']);
    assert.equal(nativeCalls[1].content.split('\n\nCapture sources: ')[0], claims.join('\n\n'));
  });
}

for (const continuity of ['unknown', 'new_task', 'changed']) {
  test(`body budget retention cannot authorize ${continuity} continuity or preserve rejected support`, async (t) => {
    const current = await fixture(t, { continuity, propose(packet) {
      if (packet.current_user_id === 't1') return { candidates: [] };
      if (packet.current_user_id === 't4') {
        assert.equal(packet.sources.every((source) => source.user_id === 't4'), true);
        return { candidates: [] };
      }
      const fresh = packet.sources.find((source) => source.user_id === packet.current_user_id);
      if (packet.current_user_id === 't2') return { candidates: [{ statements: [{ text: 'A'.repeat(1190), citations: [ref(fresh)] }] }] };
      const prior = packet.sources.find((source) => source.user_id === 't1');
      assert.ok(prior);
      return { candidates: [{ statements: [{ text: 'Quartz alpha jobs require approval.', citations: [ref(prior), ref(fresh)] }] }] };
    } });
    await current.turn('t1', 'Find the Quartz alpha approval route.');
    assert.equal((await current.turn('t2', 'Continue the same Quartz alpha job.')).detail.metadata.reason, 'body_budget');
    const third = await current.turn('t3', 'Verify Quartz in an uncertain environment.');
    assert.equal(third.detail.metadata.reason, 'continuity_unknown');
    assert.equal(third.detail.metadata.model_calls, 2);
    await current.turn('t4', 'Check the later Quartz task.');
    assert.equal(current.calls.some((call) => call.type === 'write'), false);
  });
}
