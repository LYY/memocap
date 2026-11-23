const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { harness } = require('./capture-pipeline-host/harness.cjs');
const { pipeline, generation, meta, writes, packet, citation } = require('./capture-pipeline-host/helpers.cjs');
const { write } = require('./setup-package-lifecycle-fixture.cjs');
const { createHash } = require('node:crypto');
const { supportReply } = require('./opencode-capture/harness.cjs');

function supportFixture(status = 'standalone') {
  const sources = [{ source_id: 'fresh', user_id: 'now', text: 'Prefer concise Chinese.' },
    ...(status === 'current' ? [] : [{ source_id: 'old', user_id: 'before', text: 'Only for alpha.' }])].map((source) => ({ ...source,
      content_hash: createHash('sha256').update(source.text).digest('hex') }));
  const initial = { current_user_id: 'now', sources };
  const text = JSON.stringify(initial);
  const refs = (status === 'supported' ? sources : sources.slice(0, 1)).map((source) => citation(source, 1));
  const compact = { evidence_packet_sha256: createHash('sha256').update(text).digest('hex'),
    persisted_body: 'Concise Chinese for alpha.', candidate: { statements: refs.map((ref) => ({ text: ref.quote, citations: [ref] })) },
    citation_roles: refs.map((_, statement_index) => ({ statement_index, citation_index: 0,
      role: statement_index === 0 ? 'current' : 'prior' })) };
  compact.witness_id = createHash('sha256').update(JSON.stringify(compact)).digest('hex');
  const messages = [{ role: 'user', content: [{ type: 'text', text }] },
    { role: 'assistant', content: '{"candidates":[]}' }, { role: 'user', content: JSON.stringify(compact) }];
  return { current: pipeline({ provider: { requests: [{ body: { messages } }], responses: [] } }), initial, compact, messages, refs };
}

for (const status of ['current', 'standalone', 'supported']) test(`scripted support resolves ${status} from same-child history`, () => {
  const { current, refs, compact } = supportFixture(status);
  const verdict = JSON.parse(current.support().text);
  assert.deepEqual(verdict, { memory: { status: 'accept' },
    statements: refs.map((_, index) => ({ index, status: 'supported' })),
    continuity: status === 'current' ? { status } : { status, witness_id: compact.witness_id } });
  assert.deepEqual(JSON.parse(supportReply(current.provider).text), verdict);
});

for (const fault of ['role', 'occurrence', 'witness']) test(`scripted support rejects self-hashed ${fault} tampering`, () => {
  const { current, compact, messages } = supportFixture('supported');
  if (fault === 'role') compact.citation_roles[1].role = 'current';
  if (fault === 'occurrence') compact.citation_roles.pop();
  delete compact.witness_id;
  compact.witness_id = fault === 'witness' ? '0'.repeat(64) : createHash('sha256').update(JSON.stringify(compact)).digest('hex');
  messages.at(-1).content = JSON.stringify(compact);
  assert.throws(() => current.support().text, assert.AssertionError);
  assert.throws(() => supportReply(current.provider).text, assert.AssertionError);
});

for (const fault of ['missing', 'mismatch', 'foreign', 'ambiguous', 'hash', 'quote', 'span']) {
  test(`scripted support rejects ${fault} evidence binding`, () => {
    const { current, compact, messages } = supportFixture();
    const ref = compact.candidate.statements[0].citations[0];
    switch (fault) {
      case 'missing': current.provider.requests.unshift({ body: { messages: messages.slice(0, 1) } }); messages.shift(); break;
      case 'mismatch': compact.evidence_packet_sha256 = '0'.repeat(64); break;
      case 'foreign': messages[0].role = 'assistant'; break;
      case 'ambiguous': messages.unshift(structuredClone(messages[0])); break;
      case 'hash': ref.content_hash = '0'.repeat(64); break;
      case 'quote': ref.quote = 'Unobserved'; break;
      case 'span': ref.span.end += 1; break;
      default: assert.fail(fault);
    }
    messages.at(-1).content = JSON.stringify(compact);
    assert.throws(() => current.support().text, assert.AssertionError);
    assert.throws(() => supportReply(current.provider).text, assert.AssertionError);
  });
}

test('scripted support retains review mutation hooks with the compact packet', () => {
  const { current, compact } = supportFixture();
  current.reviewSupport = (result, context) => {
    assert.deepEqual(context, compact);
    return { ...result, memory: { status: 'reject' } };
  };
  assert.equal(JSON.parse(current.support().text).memory.status, 'reject');
  assert.equal(JSON.parse(current.support((result) => ({ ...result, memory: { status: 'unknown' } })).text).memory.status, 'unknown');
});

test('scripted extraction preserves an explicitly queued support round before commit', () => {
  const { current, messages, refs } = supportFixture();
  current.provider.requests[0].body.messages = messages.slice(0, 1);
  const support = current.support();
  const commit = { tool: 'memocap_remember' };
  current.provider.responses.push(support, commit);
  JSON.parse(current.extract(() => ({ candidates: [{ statements: [{ text: refs[0].quote, citations: refs }] }] })).text);
  assert.deepEqual(current.provider.responses, [support, commit]);
});

test('capture final native input blocks recognized secrets before local provider HTTP',
  { skip: process.env.MEMOCAP_CAPTURE_E2E !== '1', timeout: 240000 }, async (t) => {
  const explicit = process.env.MEMOCAP_CAPTURE_HOST_EXECUTABLE !== undefined;
  assert.ok(explicit || ['0', '1'].includes(process.env.MEMOCAP_CAPTURE_PACKAGED_HOST));
  const scratchLabel = explicit ? 'selected' : process.env.MEMOCAP_CAPTURE_PACKAGED_HOST === '1' ? '1193' : '1195';
  const phase = process.env.MEMOCAP_CAPTURE_NATIVE_PHASE ?? 'green';
  const destination = path.resolve(__dirname, '../.omo/evidence/capture-expansion');
  const evidence = { mode: 'production', status: 'working', cleanup: {}, cases: [], commands: [], phase };
  const scratch = path.join(destination, `native-input-${scratchLabel}-${phase}-${Date.now()}`);
  const current = pipeline(await harness(evidence, scratch));
  const version = explicit ? evidence.host.version : evidence.host.version.replaceAll('.', '');
  const failures = [];
  try {
    for (const probe of [
      { surface: 'system', stage: 'extract', round: 1 },
      { surface: 'messages', stage: 'extract', round: 1 },
      { surface: 'parts', stage: 'extract', round: 1 },
      { surface: 'system_messages', stage: 'extract', round: 1 },
      { surface: 'accumulated', stage: 'extract', round: 2 },
      { surface: 'system', stage: 'commit', round: 1 },
    ]) {
      current.control.settings.captureNativeInput = probe;
      const parent = await current.parent();
      const start = current.control.events.length;
      const http = current.provider.requests.length;
      const before = writes(current.control);
      const prior = probe.stage === 'commit' ? 2 : probe.round - 1;
      const extract = { get text() {
        const context = packet(current);
        const source = context.sources.find((entry) => entry.kind === 'user_statement');
        current.provider.responses.unshift(current.support());
        return JSON.stringify({ candidates: [{ statements: [{ text: `Preference: ${source.text}`, citations: [citation(source)] }] }] });
      } };
      current.provider.responses.push({ text: 'Confirmed.' },
        ...(prior ? [extract] : []), { text: '{"candidates":[]}' });
      await current.prompt(parent, `For future responses prefer concise Chinese for native ${probe.surface} ${probe.stage}.`);
      const review = await current.review(parent, start);
      const events = current.control.events.slice(start);
      const requests = current.provider.requests.slice(http);
      const injected = events.filter((event) => event.phase === 'native.input.injected');
      const blocked = events.filter((event) => event.phase === 'input.blocked');
      const leaked = requests.filter((request) => JSON.stringify(request).includes('fixture-native-only')).length;
      const outcome = { ...probe, review: meta(review), injected, blocked, provider_http: requests.length,
        expected_http: 1 + prior, synthetic_secret_http: leaked, native_writes: writes(current.control) - before };
      evidence.cases.push(outcome);
      try {
        assert.ok(injected.length > 0, 'actual native transform injection must run');
        assert.ok(blocked.some((event) => event.code === 'sensitive_input'), 'actual native input must reject recognized secret');
        assert.equal(leaked, 0, 'synthetic secret must not reach local provider HTTP');
        assert.equal(requests.length, 1 + prior);
        assert.equal(writes(current.control), before);
        assert.equal(meta(review).write_attempts, 0);
      } catch (error) { failures.push({ probe, error: error.stack }); }
      current.provider.responses.length = 0;
    }
    delete current.control.settings.captureNativeInput;
    await generation(current, evidence);
    assert.deepEqual(current.provider.errors, []);
    assert.deepEqual(failures, []);
    evidence.status = 'passed';
  } catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
  finally {
    evidence.failures = failures;
    await current.close();
    write(path.join(destination, `capture-native-input-host-${version}-${phase}.json`), JSON.stringify(evidence, null, 2));
    t.diagnostic(JSON.stringify({ status: evidence.status, cases: evidence.cases.length, cleanup: evidence.cleanup, failures }));
  }
});
