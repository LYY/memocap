const assert = require('node:assert/strict');
const test = require('node:test');
const { driver } = require('./maintenance-observation-driver.cjs');
const stages = (result) => result.events.filter((event) => event.phase === 'maintenance.decision');

for (const phase of ['review.started', 'review.finished']) test(`async ${phase} observer failure settles through the public coordinator`, async () => {
  const result = await driver({ observer: async (event) => {
    if (event.phase === phase) throw new Error('lifecycle sink rejected');
  } });
  assert.equal(result.summary.write_attempts, 0);
  if (phase === 'review.started') {
    assert.equal(result.summary.status, 'blocked');
    assert.equal(result.summary.reason, 'maintenance_observation_failed');
    assert.equal(result.requests.length, 0);
  } else {
    assert.equal(result.summary.status, 'proposal');
    assert.equal(result.summary.observation_warning, 'maintenance_observation_failed');
  }
});

test('supported grantless mutation exposes actual issuance before the compatible final summary', async () => {
  const result = await driver();
  const trace = stages(result);
  assert.deepEqual(trace.map((event) => event.stage), ['raw_proposal', 'validated_decision', 'support_assessment', 'issuance']);
  const issued = trace[3];
  assert.equal(issued.proposal.proposal_id, result.summary.proposal.proposal_id);
  assert.equal(issued.proposal.review_status, 'supported');
  assert.equal(issued.proposal.used[0].snapshot.content, 'old route');
  assert.equal(issued.proposal.evidence[0].text, 'Check current route');
  assert.equal(issued.proposal.decision.content, trace[0].candidate.decision.content);
  assert.equal(issued.decision_fingerprint, trace[2].assessment.decision_fingerprint);
  assert.equal(issued.evidence_fingerprint, trace[2].assessment.evidence_fingerprint);
  assert.equal(result.events.at(-1).phase, 'maintenance.review');
  const { phase, parentID, ...final } = result.events.at(-1);
  assert.deepEqual(final, result.summary);
  assert.equal(result.requests.length, 2);
  assert.equal(result.summary.write_attempts, 0);
});

function citationReview({ text, quote = text, override, commit }) {
  return driver({ commit, ready(maintenance) {
    maintenance.event({ event: { type: 'message.part.updated', properties: { part: {
      id: 'verified', sessionID: 'parent', messageID: 'assistant', type: 'tool', tool: 'bash',
      state: { status: 'completed', time: { end: 41 }, output: text,
         metadata: { truncated: false, exit: 0, output: text } },
    } } } });
  }, decision(decision, packet) {
    const source = packet.evidence.find((entry) => entry.source_id === 'verified');
    return { ...decision, citations: [{ source_id: source.source_id, quote, ...override }] };
  } });
}

test('quote-only decision binds exact Unicode codepoints before support and commit', async () => {
  const quote = '\u4e2d\u{1f9ed}e\u0301';
  const text = `\u{1f600}:${quote}!`;
  const result = await citationReview({ text, quote, commit: true });
  assert.equal(result.summary.status, 'committed', result.summary.reason);
  const [raw, normalized, support, issued] = stages(result);
  const reported = { source_id: 'verified', quote };
  assert.deepEqual(raw.candidate.decision.citations, [reported]);
  const expected = { ...raw.candidate.decision, citations: [{ source_id: reported.source_id,
    content_hash: require('./maintenance-fixture.cjs').hash(text), start: 2, end: 6, quote }] };
  assert.deepEqual(normalized.validated.decision, expected);
  assert.equal(Object.hasOwn(normalized, 'citation_offset_correction'), false);
  assert.deepEqual(result.requests[1].decision, expected);
  assert.deepEqual(issued.proposal.decision, expected);
  const { fingerprint } = await import('../plugin/maintenance/boundary.js');
  const expectedFingerprint = fingerprint([expected, normalized.used]);
  assert.equal(normalized.validated.decision_fingerprint, expectedFingerprint);
  assert.equal(support.assessment.decision_fingerprint, expectedFingerprint);
  assert.equal(issued.decision_fingerprint, expectedFingerprint);
  assert.equal(result.records[0].content, expected.content);
});

for (const [name, input, reason] of [
  ['overlapping matches', { text: 'aaaa', quote: 'aaa' }, 'evidence_span_mismatch'],
  ['repeated matches', { text: 'route:route', quote: 'route' }, 'evidence_span_mismatch'],
  ['absent verbatim quote (no normalization)', { text: 'e\u0301', quote: '\u00e9' }, 'evidence_span_mismatch'],
  ['model-supplied hash', { text: 'route', override: { content_hash: require('./maintenance-fixture.cjs').hash('route') } }, 'invalid_request'],
  ['unnamed source', { text: 'route', override: { source_id: 'other' } }, 'evidence_mismatch'],
  ['extra citation key', { text: 'route', override: { extra: true } }, 'invalid_request'],
  ['correct model offsets', { text: 'route', override: { start: 0, end: 5 } }, 'invalid_request'],
  ['one-short model offsets', { text: 'route', override: { start: 0, end: 4 } }, 'invalid_request'],
  ['empty quote', { text: 'x', quote: '' }, 'invalid_request'],
  ['resolved quote over budget', { text: 'x'.repeat(801) }, 'input_budget'],
]) test(`model quote ingress does not admit ${name}`, async () => {
  const result = await citationReview({ ...input, commit: true });
  assert.equal(result.summary.status, 'blocked');
  assert.equal(result.summary.reason, reason);
  assert.deepEqual(stages(result).map((event) => event.stage), ['raw_proposal']);
  assert.equal(result.summary.write_attempts, 0);
  assert.deepEqual(result.writes, []);
  assert.equal(result.records[0].content, 'old route');
});

for (const support of ['unsupported', 'unknown']) test(`${support} support retains raw proposal without issuance`, async () => {
  const result = await driver({ support });
  assert.deepEqual(stages(result).map((event) => event.stage), ['raw_proposal', 'validated_decision', 'support_assessment']);
  assert.equal(stages(result)[0].candidate.decision.action, 'update');
  assert.equal(stages(result)[2].assessment.status, support);
  assert.equal(result.summary.reason, support);
});

test('null is observed explicitly and never issues a proposal', async () => {
  const result = await driver({ decision: () => null });
  assert.equal(stages(result).length, 1);
  assert.equal(stages(result)[0].candidate.decision, null);
  assert.equal(result.summary.status, 'no_candidate');
});

test('invalid raw decision remains visible before validation rejects it', async () => {
  const result = await driver({ decision: (decision) => ({ ...decision, extra: 'invalid' }) });
  assert.equal(stages(result).length, 1);
  assert.equal(stages(result)[0].candidate.decision.extra, 'invalid');
  assert.equal(result.summary.reason, 'invalid_request');
});

for (const [name, sourceOverride, code] of [
  ['missing', { outcome: 'missing' }, 'evidence_mismatch'],
  ['fragment', { completeness: 'fragment' }, 'evidence_mismatch'],
  ['false source digest', { content_hash: '0'.repeat(64) }, 'evidence_hash_mismatch'],
  ['duplicate identity', null, 'evidence_mismatch'],
]) test(`model citation rejects ${name} while retaining the raw update`, async () => {
  const { createMaintenanceReviewer } = await import('../plugin/maintenance/reviewer.js');
  const { maintenanceFixture } = require('./maintenance-fixture.cjs');
  const fixture = await maintenanceFixture();
  const events = [];
  const evidence = [{ ...fixture.evidence[0], ...sourceOverride }, { ...fixture.evidence[0], source_id: 'verified' }];
  const observedEvidence = sourceOverride ? evidence : [...evidence, evidence[0]];
  const turn = { task: fixture.host.task, userID: 'user', used: [fixture.used[0]], evidence: new Map(observedEvidence.map((entry, index) => [index, entry])),
    toolStates: new Map([['verified', {}]]), controller: new AbortController(), children: [], agent: 'build', model: {} };
  const reviewer = createMaintenanceReviewer({ observation: (event) => events.push(event), origin: async () => 'origin',
    tasks: { check() {}, workers: new Map(), sourceHash: () => 'hash' }, registry: fixture.registry,
    client: { config: { get: async () => ({ data: {} }) }, app: { agents: async () => ({ data: [{ name: 'build', permission: [] }] }) },
      tool: { ids: async () => ({ data: ['memocap_maintain'] }) }, session: { get: async () => ({ data: { permission: [] } }),
        create: async () => ({ data: { id: 'child' } }), prompt: async () => ({ data: { info: { finish: 'stop' },
           parts: [{ type: 'text', text: JSON.stringify({ decision: { ...fixture.decision,
             citations: fixture.decision.citations.map(({ source_id, quote }) => ({ source_id, quote })) } }) }] } }) } } });
  await assert.rejects(reviewer.review(turn), { code });
  assert.deepEqual(events.map((event) => event.stage), ['raw_proposal']);
  assert.equal(events[0].candidate.decision.action, 'update');
  if (name === 'missing' || name === 'fragment') {
    assert.equal((await import('../plugin/maintenance/assessment.js')).validateMaintenanceDecision(fixture.decision,
      { used: turn.used, evidence }).decision.action, 'unknown');
  }
  fixture.registry.dispose();
});

test('denied grant still leaves exactly one issued supported mutation', async () => {
  const result = await driver({ deny: true });
  assert.equal(stages(result).filter((event) => event.stage === 'issuance').length, 1);
  assert.equal(stages(result).at(-1).permission.action, 'deny');
  assert.equal(result.summary.reason, 'permission_deny');
  assert.equal(result.summary.write_attempts, 0);
});

test('events share review binding and cannot mutate model packets or issued state', async () => {
  const result = await driver({ observer(event) {
    if (event.phase !== 'maintenance.decision') return;
    assert.equal(Object.isFrozen(event), true);
    assert.equal(Reflect.set(event.task, 'taskID', 'changed'), false);
    if (event.candidate) assert.equal(Reflect.set(event.candidate.decision, 'content', 'changed'), false);
    if (event.proposal) assert.equal(Reflect.set(event.proposal.used[0].snapshot, 'content', 'changed'), false);
  } });
  const trace = stages(result);
  assert.equal(new Set(trace.map((event) => event.review_id)).size, 1);
  assert.equal(trace[0].task.parentID, 'parent');
  assert.equal(trace[0].user_id, 'user');
  assert.match(trace[0].task.taskID, /^[a-f0-9-]{36}$/);
  assert.match(trace[0].origin_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.requests[1].decision.content, 'new route');
  assert.equal(result.records[0].content, 'old route');
  assert.equal(trace[3].proposal.decision.content, 'new route');
  assert.ok(trace.every((event) => Buffer.byteLength(JSON.stringify(event)) <= 131072));
});

for (const content of ['password=synthetic-secret', '\ud800']) test('unsafe response emits reason only without rejected content', async () => {
  const result = await driver({ decision: (decision) => ({ ...decision, content }) });
  assert.equal(stages(result).length, 1);
  assert.equal(stages(result)[0].reason, 'unsafe_response');
  assert.equal(stages(result)[0].candidate, undefined);
  assert.equal(JSON.stringify(result.events).includes(content), false);
  assert.equal(result.summary.status, 'blocked');
});

test('observer rejection is explicit and prevents issuance and commit', async () => {
  const result = await driver({ observer(event) { if (event.phase === 'maintenance.decision') throw new Error('observer fixture'); } });
  assert.equal(result.summary.reason, 'maintenance_observation_failed');
  assert.equal(result.summary.status, 'blocked');
  assert.equal(result.summary.write_attempts, 0);
  assert.equal(stages(result).length, 1);
});

test('omitting observer preserves existing summary and request counts', async () => {
  const result = await driver({ disabled: true });
  assert.equal(result.events.length, 0);
  assert.equal(result.summary.reason, 'maintenance_grant_required');
  assert.equal(result.requests.length, 2);
  assert.equal(result.summary.write_attempts, 0);
});

test('malformed bounded JSON is visible without inventing validation or issuance', async () => {
  const result = await driver({ answer: () => '{"decision":' });
  assert.equal(stages(result).length, 1);
  assert.equal(stages(result)[0].raw_text, '{"decision":');
  assert.equal(result.summary.reason, 'invalid_proposal');
});

test('oversized answer is reason-only and preserves existing proposal budget rejection', async () => {
  const result = await driver({ answer: () => 'x'.repeat(16001) });
  assert.equal(stages(result).length, 1);
  assert.equal(stages(result)[0].reason, 'proposal_budget');
  assert.equal(stages(result)[0].raw_text, undefined);
  assert.equal(result.summary.reason, 'proposal_budget');
});

test('invalid support stays observable before its binding check rejects issuance', async () => {
  const result = await driver({ answer: (value, packet) => JSON.stringify(packet.stage === 'support'
    ? { ...value, decision_fingerprint: 'wrong' } : value) });
  assert.equal(stages(result).length, 3);
  assert.equal(stages(result)[2].assessment.decision_fingerprint, 'wrong');
  assert.equal(result.summary.reason, 'review_mismatch');
});

test('issuance observer failure records the real issued ID but cannot become a successful commit', async () => {
  const result = await driver({ observer: async (event) => {
    if (event.stage === 'issuance') throw new Error('sink rejected issuance');
  } });
  assert.match(stages(result).at(-1).proposal.proposal_id, /^[a-f0-9-]{36}$/);
  assert.equal(result.summary.reason, 'maintenance_observation_failed');
  assert.equal(result.summary.status, 'blocked');
  assert.equal(result.summary.write_attempts, 0);
});

test('observer caps repeated stages and byte-heavy evidence without exposing rejected data', async () => {
  const { createDecisionObservation } = await import('../plugin/maintenance/observation.js');
  const events = [];
  const task = { parentID: 'parent', taskID: 'task', epoch: 1 };
  const observe = createDecisionObservation((event) => events.push(event), { task, userID: 'user', origin: 'origin', sourceHash: 'source' });
  for (const stage of ['raw_proposal', 'validated_decision', 'support_assessment', 'issuance']) {
    await observe(stage, { evidence: 'x'.repeat(131072) });
    await observe(stage, { evidence: 'duplicate' });
  }
  assert.equal(events.length, 4);
  assert.ok(events.every((event) => event.reason === 'observation_budget' && event.evidence === undefined));
  task.epoch = 2;
  assert.equal(events[0].task.epoch, 1);
});
