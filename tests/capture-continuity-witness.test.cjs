const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { fixture, ref } = require('./capture-pipeline-fixture.cjs');

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const claims = ['Alpha uses jobs/start after approval; never use for beta.',
  'Require independent result checksum verification after submission.'];

async function mixed(t, assess) {
  let proposal;
  let initial;
  let expected;
  let actual;
  let frozenInputs;
  const current = await fixture(t, { propose(packet) {
    if (packet.current_user_id === 't1') return { candidates: [] };
    initial = packet;
    const old = packet.sources.find((source) => source.user_id === 't1' && source.kind === 'file_content');
    const fresh = packet.sources.find((source) => source.user_id === 't2' && source.kind === 'command_result');
    proposal = { kind: 'context', statements: claims.map((text) => ({ text, citations: [ref(old), ref(fresh)] })) };
    frozenInputs = structuredClone({ initial, proposal });
    return { candidates: [proposal] };
  }, assess(_packet, verdict) {
    const resolved = proposal.statements[0].citations.map((citation) => {
      const source = initial.sources.find((source) => source.source_id === citation.source_id);
      return { ...citation, user_id: source.user_id, pointer: source.pointer };
    });
    const persistedBody = `${claims.join('\n\n')}\n\nCapture sources: ${JSON.stringify({ statements: claims.map((text) => text.length),
      citations: resolved.map((citation) => ({ content_hash: citation.content_hash, span: [0, 32],
        excerpt: citation.quote.slice(0, 32), fragment: true, type: citation.pointer.type,
        locator: citation.pointer.locator, observed_at: citation.pointer.observed_at,
        ...(citation.pointer.line_range ? { lines: [1, 1] } : {}) })) })}`;
    expected = { evidence_packet_sha256: digest(initial),
      persisted_body: persistedBody,
      candidate: proposal, citation_roles: [
        { statement_index: 0, citation_index: 0, role: 'prior' },
        { statement_index: 0, citation_index: 1, role: 'current' },
        { statement_index: 1, citation_index: 0, role: 'prior' },
        { statement_index: 1, citation_index: 1, role: 'current' },
      ] };
    actual = current.calls.at(-1).requestPacket;
    const response = { ...verdict, continuity: { status: 'supported', witness_id: digest(expected) } };
    return assess ? assess(response, expected) : response;
  } });
  await current.turn('t1', 'Find the alpha route.', [{ text: 'Alpha uses jobs/start after approval; never use for beta.' }]);
  const result = await current.turn('t2', 'Verify that same alpha task.', [{ kind: 'command', text: 'Independent alpha checksum verified after approved submission.' }]);
  assert.deepEqual(actual, { ...expected, witness_id: digest(expected) });
  assert.deepEqual({ initial, proposal }, frozenInputs);
  return { current, result };
}

test('packet-bound witness admits exact mixed citations including repeated occurrence roles', async (t) => {
  const { current, result } = await mixed(t);
  assert.equal(result.detail.metadata.status, 'saved');
  assert.equal(current.calls.filter((call) => call.type === 'write').length, 1);
});

for (const field of ['evidence_packet_sha256', 'persisted_body', 'kind', 'text', 'source_id', 'content_hash',
  'span', 'quote', 'citation_order', 'statement_order', 'role', 'statement_index', 'citation_index']) {
  test(`stale witness rejects changed ${field} with no write`, async (t) => {
    const { current, result } = await mixed(t, (response, expected) => {
      const changed = structuredClone(expected);
      if (field === 'evidence_packet_sha256') changed[field] = '0'.repeat(64);
      if (field === 'persisted_body') changed[field] += ' changed';
      if (field === 'kind') changed.candidate.kind = 'runbook';
      if (field === 'text') changed.candidate.statements[0].text += ' changed';
      if (field === 'source_id') changed.candidate.statements[0].citations[0].source_id += ' changed';
      if (field === 'content_hash') changed.candidate.statements[0].citations[0].content_hash = '0'.repeat(64);
      if (field === 'span') changed.candidate.statements[0].citations[0].span.end -= 1;
      if (field === 'quote') changed.candidate.statements[0].citations[0].quote += ' changed';
      if (field === 'citation_order') changed.candidate.statements[0].citations.reverse();
      if (field === 'statement_order') changed.candidate.statements.reverse();
      if (field === 'role') changed.citation_roles[0].role = 'current';
      if (field === 'statement_index') changed.citation_roles[0].statement_index = 1;
      if (field === 'citation_index') changed.citation_roles[0].citation_index = 1;
      response.continuity.witness_id = digest(changed);
      return response;
    });
    assert.equal(result.detail.metadata.reason, 'continuity_unknown');
    assert.equal(current.calls.some((call) => call.type === 'write'), false);
  });
}

for (const continuity of [undefined, true, { status: 'supported' }, { status: 'supported', witness_id: 'wrong' },
  { status: 'current' }, { status: 'unknown' }, { status: 'new_task' }, { status: 'changed' },
  { status: 'unsupported' }, { status: 'supported', citations: [] }]) {
  test(`mixed witness rejects malformed continuity ${JSON.stringify(continuity)}`, async (t) => {
    const { current, result } = await mixed(t, (response) => ({ ...response, continuity }));
    assert.equal(result.detail.metadata.reason, 'continuity_unknown');
    assert.equal(current.calls.some((call) => call.type === 'write'), false);
  });
}

for (const change of ['extra', 'index', 'memory', 'statement']) {
  test(`witness cannot authorize ${change} support verdict`, async (t) => {
    const { current, result } = await mixed(t, (response) => {
      if (change === 'extra') response.continuity.citations = [];
      if (change === 'index') response.statements[0].index = 1;
      if (change === 'memory') response.memory.status = 'reject';
      if (change === 'statement') response.statements[1].status = 'unknown';
      return response;
    });
    assert.notEqual(result.detail.metadata.status, 'saved');
    assert.equal(current.calls.some((call) => call.type === 'write'), false);
  });
}

test('current-only accepts the exact current shape', async (t) => {
  const current = await fixture(t);
  const result = await current.turn('t1', 'Prefer concise Chinese for future responses.');
  assert.equal(result.detail.metadata.status, 'saved');
});

for (const continuity of [undefined, null, true, {}, { status: 'current', citations: [] },
  { status: 'current', witness_id: '0'.repeat(64) }, { status: 'current', extra: true },
  { status: 'supported', witness_id: '0'.repeat(64) }, { status: 'unknown' }, { status: 'changed' }]) {
  test(`current-only rejects malformed continuity ${JSON.stringify(continuity)}`, async (t) => {
    const current = await fixture(t, { assess: (_packet, verdict) => ({ ...verdict, continuity }) });
    const result = await current.turn('t1', 'Prefer concise Chinese for future responses.');
    assert.equal(result.detail.metadata.reason, 'continuity_unknown');
    assert.equal(current.calls.some((call) => call.type === 'write'), false);
  });
}

for (const outcome of ['role_only', 'standalone', 'missing_witness', 'stale_witness']) {
  test(`three-turn current-only capture: ${outcome}`, async (t) => {
    const instructions = 'For archival scans, calibrate against the gray card before measuring.';
    const setup = 'The archival scanner was calibrated against the gray card.';
    const final = outcome === 'role_only' ? 'An independent reading verified 300 dpi.' :
      'For exhibit labels, use matte stock to prevent glare.';
    const current = await fixture(t, { propose(packet) {
      if (packet.current_user_id !== 't3') return { candidates: [] };
      const source = packet.sources.find((entry) => entry.user_id === 't3' && entry.text === final);
      return { candidates: [{ statements: [{ text: final, citations: [ref(source)] }] }] };
    }, assess(packet, verdict) {
      switch (outcome) {
        case 'role_only': return { ...verdict, continuity: { status: 'current' } };
        case 'standalone': return { ...verdict, continuity: { status: 'standalone', witness_id: packet.witness_id } };
        case 'missing_witness': return { ...verdict, continuity: { status: 'standalone' } };
        case 'stale_witness': return { ...verdict, continuity: { status: 'standalone', witness_id: '0'.repeat(64) } };
      }
    } });
    await current.turn('t1', 'Find the calibration rule for archival scans.', [{ text: instructions }]);
    await current.turn('t2', 'Calibrate the same archival scanner.', [{ kind: 'command', text: setup }]);
    const boundary = current.calls.length;
    const third = await current.turn('t3', outcome === 'role_only' ? 'Verify resolution for that same archival scan.' :
      `New task: set a durable rule for exhibit labels. ${final}`,
    [{ kind: outcome === 'role_only' ? 'command' : 'read', text: final }]);

    const calls = current.calls.slice(boundary);
    const [raw, support] = calls.filter((call) => call.type === 'generation');
    for (const [owner, fact] of [['t1', instructions], ['t2', setup], ['t3', final]]) {
      assert.ok(raw.requestPacket.sources.some((source) => source.user_id === owner && source.text === fact),
        `extraction input must include ${owner}: ${fact}`);
    }
    assert.deepEqual(support.requestPacket.citation_roles, [{ statement_index: 0, citation_index: 0, role: 'current' }]);
    const writes = calls.filter((call) => call.type === 'write');
    if (outcome === 'standalone') {
      assert.equal(third.detail.metadata.status, 'saved');
      assert.deepEqual(writes.map((call) => call.content.split('\n\nCapture sources: ')[0]), [final]);
      assert.equal(calls.filter((call) => call.type === 'readback').length, 1);
      assert.equal(calls.filter((call) => call.type === 'generation').length, 3);
      assert.equal(calls.filter((call) => call.type === 'child').length, 2);
    } else {
      assert.deepEqual(writes.map((call) => call.content.split('\n\nCapture sources: ')[0]), []);
      assert.equal(third.detail.metadata.reason, 'continuity_unknown');
      assert.equal(third.detail.metadata.write_attempts, 0);
      assert.equal(calls.filter((call) => call.type === 'generation').length, 2);
      assert.equal(calls.filter((call) => call.type === 'child').length, 1);
    }
  });
}

for (const outcome of ['complete', 'stale_t2', 'empty_t3']) {
  test(`three-turn public capture ${outcome} preserves only freshly supported route knowledge`, async (t) => {
    const entry = 'Alpha uses jobs/start with config alpha; approval is required; never use for beta.';
    const queued = 'Alpha job 42 was queued after approval; completion is not yet verified.';
    const verified = 'Alpha job 42 completed; its result checksum was independently verified; beta remains excluded.';
    const finalClaims = [entry, 'Independently verify the completed alpha job result checksum; one run grants no future approval.'];
    const originals = new Map();
    const proposed = new Map();
    const readbacks = [];
    const current = await fixture(t, { propose(packet) {
      originals.set(packet.current_user_id, structuredClone(packet));
      if (packet.current_user_id === 't3' && outcome !== 'complete') return { candidates: [] };
      const prior = packet.sources.find((source) => source.user_id === 't1' && source.kind === 'file_content');
      const fresh = packet.sources.find((source) => source.user_id === packet.current_user_id && source.kind === 'command_result');
      const texts = packet.current_user_id === 't1' ? [entry] : packet.current_user_id === 't2' ? [entry, queued] : finalClaims;
      const candidate = { kind: 'context', statements: texts.map((text, index) => ({ text,
        citations: [ref(index === 0 ? prior : fresh)] })) };
      proposed.set(packet.current_user_id, structuredClone(candidate));
      return { candidates: [candidate] };
    }, assess(packet, verdict) {
      return outcome === 'stale_t2' && packet.current_user_id === 't2' ?
        { ...verdict, continuity: { status: 'supported', witness_id: '0'.repeat(64) } } : verdict;
    } });
    const execute = current.capture.execute;
    current.capture.execute = async (...args) => {
      const receipt = await execute(...args);
      readbacks.push(structuredClone(receipt.readback));
      return receipt;
    };
    const first = await current.turn('t1', 'Find the alpha job entry and restrictions.', [{ text: entry }]);
    assert.equal(first.detail.metadata.status, 'saved');
    const second = await current.turn('t2', 'Continue the same alpha job 42 after approval.', [{ kind: 'command', text: queued }]);
    assert.equal(second.detail.metadata.status, outcome === 'stale_t2' ? 'skipped' : 'saved');
    if (outcome === 'stale_t2') assert.equal(second.detail.metadata.reason, 'continuity_unknown');
    const secondPacket = current.calls.find((call) => call.requestPacket?.candidate && call.packet.current_user_id === 't2').requestPacket;
    const secondExpected = { evidence_packet_sha256: digest(originals.get('t2')), persisted_body: secondPacket.persisted_body,
      candidate: proposed.get('t2'), citation_roles: [{ statement_index: 0, citation_index: 0, role: 'prior' },
        { statement_index: 1, citation_index: 0, role: 'current' }] };
    assert.deepEqual(secondPacket, { ...secondExpected, witness_id: digest(secondExpected) });
    assert.equal(secondPacket.persisted_body.split('\n\nCapture sources: ')[0], [entry, queued].join('\n\n'));
    const boundary = current.calls.length;
    const priorReadbacks = readbacks.length;

    const third = await current.turn('t3', 'Independently verify the same alpha job 42 result.', [{ kind: 'command', text: verified }]);

    const calls = current.calls.slice(boundary);
    const original = originals.get('t3');
    if (outcome !== 'complete') {
      assert.equal(third.detail.metadata.reason, 'no_candidate');
      assert.equal(calls.filter((call) => call.type === 'write').length, 0);
      assert.equal(readbacks.length, priorReadbacks);
      assert.equal(third.detail.metadata.write_attempts, 0);
      assert.equal(original.sources.some((source) => source.user_id !== 't3'), outcome === 'empty_t3');
      return;
    }
    const candidate = proposed.get('t3');
    const expectedBody = `${finalClaims.join('\n\n')}\n\nCapture sources: ${JSON.stringify({ statements: finalClaims.map((text) => text.length),
      citations: candidate.statements.flatMap((statement) => statement.citations).map((citation) => {
        const source = original.sources.find((entry) => entry.source_id === citation.source_id);
        return { content_hash: source.content_hash, span: [0, 32], excerpt: [...source.text].slice(0, 32).join(''),
          fragment: true, type: source.pointer.type, locator: source.pointer.locator, observed_at: source.pointer.observed_at,
          ...(source.pointer.line_range ? { lines: [1, 1] } : {}) };
      }) })}`;
    const expected = { evidence_packet_sha256: digest(original), persisted_body: expectedBody, candidate,
      citation_roles: [{ statement_index: 0, citation_index: 0, role: 'prior' },
        { statement_index: 1, citation_index: 0, role: 'current' }] };
    assert.deepEqual(calls.find((call) => call.requestPacket?.candidate).requestPacket, { ...expected, witness_id: digest(expected) });
    assert.equal(third.detail.metadata.status, 'saved');
    assert.equal(calls.filter((call) => call.type === 'child').length, 2);
    assert.equal(calls.filter((call) => call.type === 'generation').length, 3);
    assert.deepEqual(calls.filter((call) => ['write', 'readback'].includes(call.type)).map((call) => call.type), ['write', 'readback']);
    assert.equal(calls.find((call) => call.type === 'write').content, expectedBody);
    assert.equal(readbacks.at(-1).status, 'ok');
    assert.equal(readbacks.at(-1).results[0].memory.content, expectedBody);
    assert.ok([...expectedBody].length <= 1200);
  });
}
