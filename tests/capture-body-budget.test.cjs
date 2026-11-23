const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, ref } = require('./capture-pipeline-fixture.cjs');
const { statement, quotes, citations, units, sourceExtra } = require('./capture-body-fixture.cjs');

test('372-CP synthesis with complete durable provenance fits 1183 CP without mutating support evidence', async () => {
  const { identify } = await import('../plugin/capture/identity.js');
  const before = structuredClone({ units, citations });
  assert.equal([...statement].length, 372);
  assert.deepEqual(quotes.map((quote) => [...quote].length), [266, 303]);
  assert.deepEqual(citations.map((citation) => [...citation.pointer.locator].length), [151, 151]);
  assert.deepEqual(citations.map((citation) => [...citation.source_id].length), [30, 30]);

  const identity = identify(units, 'repository:fixture', citations);

  assert.equal([...identity.body].length, 1183);
  const footer = JSON.parse(identity.body.split('\n\nCapture sources: ')[1]);
  assert.deepEqual(footer.statements, [statement.length]);
  assert.deepEqual(footer.citations, citations.map((citation) => ({
    content_hash: citation.content_hash, span: [0, 32], excerpt: [...citation.quote].slice(0, 32).join(''),
    fragment: true, type: 'file', locator: citation.pointer.locator, observed_at: citation.pointer.observed_at, lines: [1, 1],
  })));
  assert.deepEqual({ units, citations }, before);
});

test('public T1 to T3 capture reaches support and one bound write with the exact 1183-CP body', async (t) => {
  const decisions = [];
  const readbacks = [];
  const current = await fixture(t, { onDecision: (event) => decisions.push(event), propose(packet) {
    if (packet.current_user_id !== 't3') return { candidates: [] };
    const selected = citations.map((citation) => packet.sources.find((source) => source.source_id === citation.source_id));
    assert.deepEqual(selected.map((source) => source.text), quotes);
    assert.ok(packet.body_budget, 'first generation needs host body capacity');
    const costs = selected.map((source) => Math.min(...packet.body_budget.reference_regions.filter((region) =>
      region.source_id === source.source_id && region.span[0] <= source.span.start && region.span[1] >= source.span.end)
      .map((region) => region.citation_cp_upper_bound)));
    const capacities = packet.body_budget.fixed_cp_by_statement_count.map((fixed) => 1200 - fixed - costs.reduce((a, b) => a + b) - 1);
    assert.deepEqual(capacities, [382, 375, 368, 361]);
    assert.ok([...statement].length <= capacities[0]);
    return { candidates: [{ kind: 'context', statements: [{ text: statement, citations: selected.map(ref) }] }] };
  }, assess(packet, verdict) {
    assert.equal([...packet.persisted_body].length, 1183);
    assert.deepEqual(packet.candidate.statements[0].citations, citations.map(({ source_id, content_hash, span, quote }) => ({ source_id, content_hash, span, quote })));
    for (const citation of citations) {
      const source = packet.sources.find((entry) => entry.source_id === citation.source_id);
      assert.equal(source.text, citation.quote);
      assert.equal(source.content_hash, citation.content_hash);
      assert.deepEqual(source.span, citation.span);
      assert.ok(packet.bundles.some((bundle) => bundle.user_id === citation.user_id && bundle.units.some((unit) => unit.text === citation.quote)));
    }
    return verdict;
  } });
  const execute = current.capture.execute;
  current.capture.execute = async (...args) => {
    const receipt = await execute(...args);
    readbacks.push(receipt.readback);
    return receipt;
  };
  await current.turn('t1', 'Find the Vessa offline relief sheet entry and conditions.', [sourceExtra(0)]);
  await current.turn('t2', 'Continue the same Vessa offline relief sheet task.');
  const boundary = current.calls.length;

  const review = await current.turn('t3', 'Verify the same Vessa renderer gap setting.', [sourceExtra(1)]);

  assert.equal(review.detail.metadata.status, 'saved', review.detail.metadata.reason);
  const calls = current.calls.slice(boundary);
  const dispatched = calls.find((call) => call.type === 'generation');
  const provenance = decisions.findLast((event) => event.stage === 'raw_proposal').input_provenance.packet;
  const { createHash } = require('node:crypto');
  assert.deepEqual(provenance, { sha256: createHash('sha256').update(dispatched.serialized).digest('hex'),
    utf8_bytes: Buffer.byteLength(dispatched.serialized) });
  assert.ok(calls.filter((call) => call.type === 'generation').every((call) => call.model.providerID === 'wire' &&
    call.model.modelID === 'wire-model' && call.agent === 'build'));
  const supported = calls.find((call) => call.packet?.persisted_body).packet.persisted_body;
  const identity = decisions.findLast((event) => event.stage === 'identity').identity;
  const issued = decisions.findLast((event) => event.stage === 'issuance').candidate;
  assert.equal(identity.body, supported);
  assert.equal(issued.body, supported);
  assert.equal([...supported].length, 1183);
  assert.equal(calls.find((call) => call.type === 'write').content, supported);
  assert.equal(readbacks[0].status, 'ok');
  assert.equal(readbacks[0].results[0].memory.content, supported);
  assert.deepEqual(issued.citations.map(({ source_id, content_hash, span, quote }) => ({ source_id, content_hash, span, quote })), citations.map(({ source_id, content_hash, span, quote }) => ({ source_id, content_hash, span, quote })));
  assert.equal(Object.isFrozen(issued.citations[0].pointer), true);
  assert.equal(calls.filter((call) => call.type === 'generation').length, 3);
  assert.equal(calls.filter((call) => call.type === 'child').length, 2);
  assert.deepEqual(calls.filter((call) => ['write', 'readback'].includes(call.type)).map((call) => call.type), ['write', 'readback']);
  assert.ok(current.reviews.every(({ detail }) => detail.metadata.model_calls <= 3 && detail.metadata.write_attempts <= 1));
});

test('C2 support retains original frozen evidence and untrusted proposal through real native hooks', async (t) => {
  const { turns, propose, digest } = require('./capture-support-input-fixture.cjs');
  let supportHistory;
  const current = await fixture(t, { nativeHistory: true,
    propose: (packet) => packet.current_user_id === 't3' ? propose(packet) : { candidates: [] },
    beforeGeneration({ requestPacket, history }) {
      if (!requestPacket.candidate) return;
      supportHistory = history;
      const frozen = JSON.parse(history[0].parts[0].text);
      assert.equal(requestPacket.evidence_packet_sha256, digest(history[0].parts[0].text));
      assert.deepEqual(Object.keys(requestPacket).sort(), ['candidate', 'citation_roles', 'evidence_packet_sha256', 'persisted_body', 'witness_id']);
      assert.equal(history.length, 3);
      for (const turn of turns) {
        const source = frozen.sources.find((entry) => entry.content_hash === turn.hash);
        assert.equal(source.text, turn.text);
        assert.deepEqual(source.span, { start: 0, end: [...turn.text].length });
        assert.ok(frozen.bundles.some((bundle) => bundle.units.some((unit) => unit.text === turn.text)));
      }
      const proposal = JSON.parse(history[1].parts[0].text);
      assert.deepEqual(requestPacket.candidate.statements, proposal.candidates[0].statements);
    } });
  for (const [index, turn] of turns.entries()) {
    await current.turn(`t${index + 1}`, turn.user, [{ kind: 'read', text: turn.text }]);
  }
  assert.ok(supportHistory);
  const review = current.reviews.at(-1).detail.metadata;
  assert.equal(review.status, 'saved', review.reason);
  assert.equal(review.model_calls, 3);
  assert.equal(review.write_attempts, 1);
  const calls = current.calls.filter((call) => call.type === 'generation' && call.packet.current_user_id === 't3');
  assert.equal(new Set(calls.map((call) => call.id)).size, 1);
  assert.equal(calls.length, 2);
  assert.equal(current.calls.filter((call) => call.type === 'write').length, 1);
});
