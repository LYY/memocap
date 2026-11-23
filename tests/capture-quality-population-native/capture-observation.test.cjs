const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { productionProbe } = require('./production-probe.cjs');

function evidenceForRequest(initialRequests, childID, text) {
  const packet = JSON.parse(text);
  if (!packet.candidate) {
    assert.equal(initialRequests.has(childID), false, 'duplicate_initial_evidence');
    initialRequests.set(childID, text);
    return packet;
  }
  const initialText = initialRequests.get(childID);
  assert.equal(typeof initialText, 'string', 'same_child_evidence_missing');
  assert.equal(packet.evidence_packet_sha256, createHash('sha256').update(initialText).digest('hex'), 'same_child_evidence_digest_mismatch');
  const evidence = JSON.parse(initialText);
  for (const statement of packet.candidate.statements) for (const citation of statement.citations) {
    const sources = evidence.sources.filter((entry) => entry.source_id === citation.source_id);
    assert.equal(sources.length, 1, 'citation_source_missing_or_duplicate');
    const source = sources[0];
    assert.equal(citation.content_hash, source.content_hash);
    assert.ok(Number.isInteger(citation.span.start) && Number.isInteger(citation.span.end) &&
      citation.span.start >= source.span.start && citation.span.end > citation.span.start && citation.span.end <= source.span.end);
    assert.equal(citation.quote, [...source.text].slice(citation.span.start - source.span.start, citation.span.end - source.span.start).join(''));
  }
  const expected = { evidence_packet_sha256: createHash('sha256').update(initialText).digest('hex'),
    persisted_body: packet.persisted_body, candidate: packet.candidate,
    citation_roles: packet.candidate.statements.flatMap((statement, statement_index) =>
      statement.citations.map((citation, citation_index) => ({ statement_index, citation_index,
        role: evidence.sources.find((source) => source.source_id === citation.source_id).user_id === evidence.current_user_id ? 'current' : 'prior' }))) };
  assert.deepEqual(packet, { ...expected, witness_id: createHash('sha256').update(JSON.stringify(expected)).digest('hex') });
  return evidence;
}

async function run(options = {}) {
  const probe = await productionProbe();
  const { createCapture } = (await probe.load('../../plugin/capture/index.js')).namespace;
  const events = [];
  let done = Promise.withResolvers();
  let serial = 0;
  const packets = [];
  const initialRequests = new Map();
  let capture;
  const permission = [{ permission: '*', pattern: '*', action: 'allow' }, { permission: 'memocap_remember', pattern: '*', action: 'deny' }];
  const state = { generation: 1, targets: [{ repository_id: 'repository:fixture' }] };
  const client = { _client: { get: async () => ({ data: { version: '1.19.3' } }) },
    tool: { ids: async () => ({ data: ['memocap_remember'] }) },
    app: { agents: async () => ({ data: [{ name: 'build', permission }] }) }, session: {
      get: async () => ({ data: { permission } }), abort: async () => ({ data: true }),
      create: async () => ({ data: { id: `child${++serial}` } }),
      prompt: async ({ path, body }) => {
        capture.params({ sessionID: path.id }, {});
        const packet = JSON.parse(body.parts[0].text);
        packets.push(packet);
        assert.ok(packets.length <= 3, 'fourth_generation_forbidden');
        if (packet.content) return { data: { info: { finish: 'stop' }, parts: [] } };
        const evidence = evidenceForRequest(initialRequests, path.id, body.parts[0].text);
        const source = evidence.sources[0];
        const reply = packet.candidate ? { ...(options.memory === null ? {} : { memory: { status: options.memory ?? 'accept' } }),
          statements: [{ index: 0, status: options.support ?? 'supported' }], continuity: { status: options.continuity ?? 'current' } } :
          options.empty ? { candidates: [] } : { candidates: [{ statements: [{ text: 'Prefer concise Chinese for future responses.', citations: [{ source_id: source.source_id,
            content_hash: source.content_hash, span: source.span, quote: options.bad ? 'foreign bytes' : source.text }] }] }] };
        return { data: { info: { finish: 'stop' }, parts: [{ type: 'text', text: JSON.stringify(reply) }] } };
      } } };
  const runtime = { warnings: [], context: async () => state, readPermission: { check: async () => {} },
    recall: async () => ({ status: 'empty', results: [] }), request: async () => ({}) };
  capture = createCapture({ client, captureObservation: { clock: { now: () => 1, setTimeout, clearTimeout }, onReview(event) { done.resolve(event); },
    onLifecycle: options.lifecycle,
     onDecision(event) { events.push(event); if (options.throw) throw new Error('observer'); } } }, runtime, {});
  try {
  if (options.prior) {
    capture.observe({ sessionID: 'root', agent: 'build', model: { providerID: 'synthetic', modelID: 'synthetic' } },
      { message: { id: 'prior', role: 'user' }, parts: [{ id: 'prior_part', type: 'text', text: 'Alpha requires approval.' }] });
    capture.event({ event: { type: 'message.updated', properties: { info: { sessionID: 'root', id: 'prior_answer', role: 'assistant',
      parentID: 'prior', finish: 'stop', time: { created: 1, completed: 2 } } } } });
    capture.event({ event: { type: 'session.status', properties: { sessionID: 'root', status: { type: 'idle' } } } });
    await done.promise;
    done = Promise.withResolvers();
    events.length = 0;
    packets.length = 0;
  }
  capture.observe({ sessionID: 'root', agent: 'build', model: { providerID: 'synthetic', modelID: 'synthetic' } },
    { message: { id: 'user', role: 'user' }, parts: [{ id: 'part', type: 'text', text: 'Prefer concise Chinese for future responses.' }] });
  capture.event({ event: { type: 'message.updated', properties: { info: { sessionID: 'root', id: 'assistant', role: 'assistant',
    parentID: 'user', finish: 'stop', time: { created: 1, completed: 2 } } } } });
  capture.event({ event: { type: 'session.status', properties: { sessionID: 'root', status: { type: 'idle' } } } });
  await done.promise;
  const result = runtime.captureStatus('root');
  return { events, result, packets, children: serial };
  } finally { await capture.dispose(); }
}

for (const phase of ['review.started', 'review.finished']) test(`capture awaits rejected async ${phase} observation`, async () => {
  const result = await run({ lifecycle: async (event) => { if (event.phase === phase) throw new Error('lifecycle sink rejected'); } });
  assert.equal(result.result.write_attempts, 0);
  if (phase === 'review.started') {
    assert.equal(result.result.status, 'failed');
    assert.equal(result.result.reason, 'capture_observation_failed');
    assert.equal(result.children, 0);
    assert.equal(result.packets.length, 0);
  } else {
    assert.equal(result.result.status, 'denied');
    assert.equal(result.result.reason, 'permission_deny');
    assert.equal(result.result.observation_warning, 'capture_observation_failed');
  }
});

test('actual supported and identity-bound frozen issuance survives later permission denial', async () => {
  const { events, packets } = await run();
  assert.deepEqual(events.map((event) => event.stage), ['raw_proposal', 'admission', 'identity', 'support_raw', 'support_acceptance', 'issuance']);
  assert.equal(events.find((event) => event.stage === 'support_acceptance').accepted.status, 'supported');
  assert.equal(events.at(-1).issuance_kind, 'host_frozen_supported_identity_bound_candidate');
  assert.equal(events.at(-1).candidate.statements[0].text, 'Prefer concise Chinese for future responses.');
  assert.equal(Object.isFrozen(events.at(-1).candidate), true);
  assert.equal(packets.length, 2);
  assert.equal(packets[1].persisted_body, events.find((event) => event.stage === 'identity').identity.body);
  assert.equal(events.at(-1).candidate.body, packets[1].persisted_body);
});
test('unsupported raw assessment never becomes accepted or issued', async () => {
  const { events } = await run({ support: 'unsupported' });
  assert.equal(events.find((event) => event.stage === 'support_raw').raw.statements[0].status, 'unsupported');
  assert.equal(events.find((event) => event.stage === 'support_acceptance').accepted.status, 'skip');
  assert.equal(events.some((event) => event.stage === 'issuance'), false);
});
for (const memory of ['reject', 'unknown', 'unsupported', null]) test(`whole-memory ${memory ?? 'missing'} rejects despite supported atoms`, async () => {
  const { events, packets } = await run({ memory });
  assert.equal(events.find((event) => event.stage === 'support_acceptance').accepted.status, 'skip');
  assert.equal(events.some((event) => event.stage === 'issuance'), false);
  assert.equal(packets.length, 2);
});
test('unknown atomic support rejects an accepted whole-memory verdict', async () => {
  const { events, packets } = await run({ support: 'unknown' });
  assert.equal(events.find((event) => event.stage === 'support_acceptance').accepted.status, 'skip');
  assert.equal(events.some((event) => event.stage === 'issuance'), false);
  assert.equal(packets.length, 2);
});
test('unknown continuity rejects an otherwise accepted supported memory', async () => {
  const { events, packets } = await run({ continuity: 'unknown' });
  assert.equal(events.find((event) => event.stage === 'support_acceptance').accepted.status, 'skip');
  assert.equal(events.some((event) => event.stage === 'issuance'), false);
  assert.equal(packets.length, 2);
});
test('invalid citation records actual admission rejection and stops before support', async () => {
  const { events } = await run({ bad: true });
  assert.deepEqual(events.map((event) => event.stage), ['raw_proposal', 'admission']);
  assert.equal(events.at(-1).accepted.status, 'skip');
});
test('observer failure changes no admission or frozen candidate result', async () => {
  const normal = await run();
  const failing = await run({ throw: true });
  assert.equal(failing.events.at(-1).candidate.body, normal.events.at(-1).candidate.body);
  assert.equal(failing.result.status, normal.result.status);
  assert.equal(failing.events.length, 6);
  assert.equal(failing.events.at(-1).stage, 'issuance');
  assert.equal(failing.result.write_attempts, normal.result.write_attempts);
  assert.equal(failing.children, normal.children);
  assert.deepEqual(failing.packets, normal.packets);
});

test('empty proposal retains the actual selected packet digest without a seventh event', async () => {
  const { createHash } = require('node:crypto');
  const { events, packets, result, children } = await run({ empty: true, prior: true });
  const provenance = events[0].input_provenance;
  assert.ok(provenance, 'raw proposal must carry selected input provenance');
  assert.deepEqual(events.map((event) => event.stage), ['raw_proposal', 'admission']);
  assert.equal(events[0].raw.candidates.length, 0);
  assert.equal(provenance.packet.sha256, createHash('sha256').update(JSON.stringify(packets[0])).digest('hex'));
  assert.equal(JSON.stringify(provenance.selected_sources.entries.map((source) => source.source_id)), JSON.stringify(['prior_part', 'part']));
  assert.equal(provenance.retained_frames.total, 2);
  assert.equal(Object.isFrozen(provenance.selected_bundles.entries[0].units[0].span), true);
  assert.equal(provenance.upstream_observation.status, 'unknown');
  assert.equal(packets.length, 1);
  assert.equal(children, 2);
  assert.equal(result.write_attempts, 0);
});

test('decision observer failure preserves the public save and independent readback path', async (t) => {
  const { fixture } = require('../capture-pipeline-fixture.cjs');
  t.mock.method(Date, 'now', () => 1);
  const normal = await fixture(t);
  const events = [];
  const failing = await fixture(t, { onDecision(event) { events.push(event); throw new Error('decision sink rejected'); } });
  const normalReview = await normal.turn('user', 'Prefer concise Chinese for future responses.');
  const failingReview = await failing.turn('user', 'Prefer concise Chinese for future responses.');
  assert.equal(failingReview.detail.metadata.status, 'saved');
  assert.equal(failingReview.detail.metadata.status, normalReview.detail.metadata.status);
  assert.equal(failingReview.detail.metadata.write_attempts, 1);
  assert.deepEqual(failing.calls.filter(({ type }) => ['child', 'generation', 'write', 'readback'].includes(type)).map(({ type }) => type),
    ['child', 'generation', 'generation', 'child', 'generation', 'write', 'readback']);
  assert.equal(events.length, 6);
  assert.equal(events[5].stage, 'issuance');
  assert.equal(failing.calls.find(({ type }) => type === 'write').content, normal.calls.find(({ type }) => type === 'write').content);
});

for (const binding of ['missing', 'mismatched', 'foreign-child']) test(`support mock rejects ${binding} evidence binding`, async () => {
  const { packets } = await run();
  const initialRequests = new Map();
  if (binding !== 'missing') evidenceForRequest(initialRequests, binding === 'foreign-child' ? 'other-child' : 'child', JSON.stringify(packets[0]));
  const support = binding === 'mismatched' ? { ...packets[1], evidence_packet_sha256: '0'.repeat(64) } : packets[1];

  assert.throws(() => evidenceForRequest(initialRequests, 'child', JSON.stringify(support)), {
    code: 'ERR_ASSERTION', message: new RegExp(binding === 'mismatched' ? 'same_child_evidence_digest_mismatch' : 'same_child_evidence_missing'),
  });
});
