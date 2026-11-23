const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { digest } = require('./packaged-runtime.cjs');
const { harness, extractionReply, supportReply } = require('./opencode-capture/harness.cjs');
const { handshakeAbort, replayIdle, rejected, mismatchAndBudget, cancelAfterCommit } = require('./opencode-capture/cases.cjs');
const { duplicate, newInput, nativeDenial, unknownReceipt, parentError } = require('./opencode-capture/races.cjs');
const { documentRoute, readFailures } = require('./opencode-capture/grounding.cjs');

test('scripted extraction binds current Unicode source spans through production admission', async () => {
  const { adaptSource, sourceBundles } = await import('../plugin/capture/sources.js');
  const { admitCandidate, admitSupport } = await import('../plugin/capture/admission.js');
  const { readObservation } = require('./capture-source-host/synthetic.cjs');
  const source = adaptSource(readObservation('Use Chinese 😀 for this fixture.')).source;
  const bundles = sourceBundles([source]).bundles;
  const packet = { current_user_id: source.user_id, sources: [source], bundles };
  const provider = { requests: [{ body: { messages: [{ role: 'user', content: JSON.stringify(packet) }] } }] };
  const proposal = JSON.parse(extractionReply(provider).text);
  const admitted = admitCandidate(proposal, { sources: new Map([[source.source_id, source]]), bundles, userID: source.user_id });
  assert.equal(admitted.status, 'candidate');
  assert.equal(admitted.candidate.statements[0].citations[0].quote, source.text);
  const first = JSON.stringify(packet);
  const review = { evidence_packet_sha256: digest(first), persisted_body: admitted.candidate.statements[0].text,
    candidate: proposal.candidates[0], citation_roles: [{ statement_index: 0, citation_index: 0, role: 'current' }] };
  review.witness_id = digest(JSON.stringify(review));
  provider.requests.push({ body: { messages: [{ role: 'user', content: first },
    { role: 'assistant', content: JSON.stringify(proposal) }, { role: 'user', content: JSON.stringify(review) }] } });
  assert.equal(admitSupport(JSON.parse(supportReply(provider).text), {
    sources: new Map([[source.source_id, source]]), bundles, userID: source.user_id, candidate: admitted.candidate,
  }).status, 'supported');
});

for (const mode of ['absent-history', 'mismatched-history', 'malformed-digest', 'assistant-only', 'duplicate-history']) {
  test(`scripted support refuses ${mode} despite a matching packet in another request`, () => {
    const packet = JSON.stringify({ current_user_id: 'u', sources: [{ source_id: 's', user_id: 'u' }] });
    const review = { evidence_packet_sha256: mode === 'malformed-digest' ? 'invalid' : digest(packet),
      persisted_body: 'fixture', candidate: { statements: [{ citations: [{ source_id: 's' }] }] } };
    const history = mode === 'absent-history' ? [] : [{ role: mode === 'assistant-only' ? 'assistant' : 'user',
      content: mode === 'mismatched-history' ? `${packet} ` : packet }];
    if (mode === 'duplicate-history') history.push({ role: 'user', content: packet });
    const provider = { requests: [{ body: { messages: [{ role: 'user', content: packet }] } },
      { body: { messages: [...history, { role: 'user', content: JSON.stringify(review) }] } }] };
    assert.throws(() => supportReply(provider).text, assert.AssertionError);
  });
}

test('production capture uses two fresh children and native permission with independent readback on OpenCode',
  { skip: process.env.MEMOCAP_CAPTURE_E2E !== '1', timeout: 240000 }, async (t) => {
    const evidence = { commands: [], cleanup: {}, paid_provider_requests: 0, cases: [] };
    const current = await harness(evidence);
    const { provider, control, client, unwrap, cli } = current;
    try {
      const parent = await current.parent();
      provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.support(), current.commit());
      await current.prompt(parent, 'For future responses, use Chinese. Keep code identifiers in English.');
      const review = await current.review(parent);
      assert.equal(review.payload.detail.metadata.status, 'saved', JSON.stringify(control.events.slice(-15)));
      assert.deepEqual(review.payload.detail.metadata, { status: 'saved', reason: 'saved_verified', memory_ids: [1],
        model_calls: 3, tool_calls: 1, write_attempts: 1 });
      const children = unwrap(await client.session.children({ path: { id: parent.id } }));
      assert.equal(children.length, 2);
      assert.equal(new Set(children.map((child) => child.id)).size, 2);
      const parentRules = unwrap(await client.session.get({ path: { id: parent.id } })).permission;
      assert.deepEqual(children.find((child) => child.title.endsWith('extract')).permission.filter((rule) => rule.permission === 'memocap_remember').at(-1).action, 'deny');
      const commitChild = children.find((child) => child.title.endsWith('commit'));
      assert.deepEqual(commitChild.permission.slice(0, parentRules.length), parentRules);
      assert.equal(commitChild.permission.filter((rule) => rule.permission === 'memocap_remember').length, 1);
      assert.equal(provider.requests.length, 4);
      assert.deepEqual(provider.requests[1].body.tools ?? [], []);
      assert.deepEqual(provider.requests[2].body.tools ?? [], []);
      assert.equal(control.events.filter((event) => event.phase === 'generation' && children.some((child) => child.id === event.sessionID)).length, 3);
      assert.ok(control.events.some((event) => event.phase === 'generation.blocked' && event.sessionID === commitChild.id && event.code === 'model_budget'));
      const saved = control.events.find((event) => event.phase === 'remember.result').receipt;
      assert.equal(saved.readback.status, 'ok');
      const listed = await cli(['list', '--repo', current.fixture.project]);
      assert.equal(listed.results[0].memory.content, saved.readback.results[0].memory.content);
      assert.equal(control.events.filter((event) => event.phase === 'native.write.spawn').length, 1);
      assert.ok(control.events.some((event) => event.phase === 'host.event' && event.event.type === 'session.idle' && event.event.properties.sessionID === parent.id));
      evidence.cases.push({ name: 'normal_and_deprecated_idle', review: review.payload.detail.metadata, persisted: review.exit_code === 0 });
      if (review.exit_code === 0) {
        const activity = await cli(['activity', 'show', review.payload.operation_id]);
        assert.deepEqual(activity.events.find((event) => event.detail.phase === 'capture_review').detail.metadata, review.payload.detail.metadata);
      }
      for (const argumentsText of ['status', 'why']) {
        provider.responses.push({ text: 'Inspected.' });
        await current.host.api(`/session/${parent.id}/command`, { command: 'memory', arguments: argumentsText, model: 'wire/wire-model' });
        const payload = JSON.parse(provider.requests.at(-1).body.messages.findLast((message) => message.role === 'user').content);
        assert.equal(payload.capture.status, 'saved');
        assert.equal(payload.capture.activity_warning, review.exit_code === 0 ? undefined : 'activity_failed');
        evidence.cases.push({ name: `memory_${argumentsText}_capture_observability`, capture: payload.capture });
      }

      const denied = await current.parent(true);
      provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.support());
      await current.prompt(denied, 'For future responses, always use concise Chinese with this denied fixture.');
      const denial = await current.review(denied);
      assert.equal(denial.payload.detail.metadata.status, 'denied');
      assert.equal(denial.payload.detail.metadata.write_attempts, 0);
      evidence.cases.push({ name: 'denied', review: denial.payload.detail.metadata });
      await handshakeAbort(current, evidence);
      await replayIdle(current, evidence);
      await rejected(current, evidence);
      await duplicate(current, evidence);
      await documentRoute(current, evidence);
      await readFailures(current, evidence);
      await newInput(current, evidence);
      await nativeDenial(current, evidence);
      await mismatchAndBudget(current, evidence);
      await cancelAfterCommit(current, evidence);
      await cancelAfterCommit(current, evidence, true);
      await unknownReceipt(current, evidence);
      await parentError(current, evidence);
      assert.deepEqual(provider.errors, []);
      evidence.status = 'passed';
    } catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
    finally {
      evidence.model_requests = provider.requests.length;
      await current.close();
      if (process.env.MEMOCAP_CAPTURE_EVIDENCE) fs.writeFileSync(process.env.MEMOCAP_CAPTURE_EVIDENCE, JSON.stringify(evidence, null, 2));
      t.diagnostic(JSON.stringify({ status: evidence.status, cases: evidence.cases, cleanup: evidence.cleanup }));
    }
  });
