const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { harness } = require('./opencode-capture/harness.cjs');
const { handshakeAbort, replayIdle, rejected, mismatchAndBudget, cancelAfterCommit } = require('./opencode-capture/cases.cjs');
const { duplicate, newInput, nativeDenial, unknownReceipt, parentError } = require('./opencode-capture/races.cjs');
const { documentRoute, readFailures } = require('./opencode-capture/grounding.cjs');

test('production capture uses two fresh children and native permission with independent readback on OpenCode',
  { skip: process.env.MEMOCAP_CAPTURE_E2E !== '1', timeout: 240000 }, async (t) => {
    const evidence = { commands: [], cleanup: {}, paid_provider_requests: 0, cases: [] };
    const current = await harness(evidence);
    const { provider, control, client, unwrap, cli } = current;
    try {
      const parent = await current.parent();
      provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit(), { text: 'Saved.' });
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
      provider.responses.push({ text: 'Confirmed.' }, current.extract());
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
