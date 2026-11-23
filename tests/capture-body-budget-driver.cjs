const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fixture, ref } = require('./capture-pipeline-fixture.cjs');
const { statement, citations, sourceExtra } = require('./capture-body-fixture.cjs');

async function run() {
  const cleanup = [];
  const decisions = [];
  const readbacks = [];
  let capacities;
  try {
    const current = await fixture({ after: (dispose) => cleanup.push(dispose) }, {
      onDecision: (event) => decisions.push(event),
      propose(packet) {
        if (packet.current_user_id !== 't3') return { candidates: [] };
        const selected = citations.map((citation) => packet.sources.find((source) => source.source_id === citation.source_id));
        const costs = selected.map((source) => Math.min(...packet.body_budget.reference_regions.filter((row) =>
          row.source_id === source.source_id && row.span[0] <= source.span.start && source.span.end <= row.span[1])
          .map((row) => row.citation_cp_upper_bound)));
        capacities = packet.body_budget.fixed_cp_by_statement_count.map((fixed) => 1200 - fixed - costs.reduce((a, b) => a + b) - 1);
        assert.ok([...statement].length <= capacities[0]);
        return { candidates: [{ kind: 'context', statements: [{ text: statement, citations: selected.map(ref) }] }] };
      },
    });
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
    assert.equal(review.detail.metadata.status, 'saved');
    const calls = current.calls.slice(boundary);
    const dispatch = calls.find((call) => call.type === 'generation');
    const packetHash = createHash('sha256').update(dispatch.serialized).digest('hex');
    assert.deepEqual(decisions.findLast((event) => event.stage === 'raw_proposal').input_provenance.packet,
      { sha256: packetHash, utf8_bytes: Buffer.byteLength(dispatch.serialized) });
    const body = calls.find((call) => call.packet?.persisted_body).packet.persisted_body;
    assert.equal([...body].length, 1183);
    assert.equal(decisions.findLast((event) => event.stage === 'issuance').candidate.body, body);
    assert.equal(calls.find((call) => call.type === 'write').content, body);
    assert.equal(readbacks[0].results[0].memory.content, body);
    const count = (type) => calls.filter((call) => call.type === type).length;
    assert.deepEqual([count('generation'), count('child'), count('write'), count('readback')], [3, 2, 1, 1]);
    const overflow = await fixture({ after: (dispose) => cleanup.push(dispose) }, {
      statement: '合'.repeat(1190), beforeGeneration({ packet }) { assert.equal(packet.body_budget.version, 1); },
    });
    const rejection = await overflow.turn('oversize', 'Prefer concise Chinese for future responses.');
    assert.equal(rejection.detail.metadata.reason, 'body_budget');
    assert.equal(overflow.calls.filter((call) => call.type === 'generation').length, 1);
    assert.equal(overflow.calls.filter((call) => call.type === 'write').length, 0);
    return { surface: 'createCapture public in-memory pipeline', capacities, body_cp: [...body].length,
      packet_sha256: packetHash, packet_utf8_bytes: Buffer.byteLength(dispatch.serialized),
      generations: count('generation'), children: count('child'), writes: count('write'), independent_readbacks: count('readback'),
      exact_body_unchanged: true, overflow: { reason: 'body_budget', generations: 1, writes: 0 },
      genuine_requests: 0, network: false, native_cli_sql: false, cleanup: 'all capture fixtures disposed' };
  } finally {
    for (const dispose of cleanup) dispose();
  }
}

run().then((proof) => console.log(JSON.stringify(proof, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
