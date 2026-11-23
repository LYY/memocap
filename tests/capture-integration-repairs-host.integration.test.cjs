const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { harness } = require('./capture-pipeline-host/harness.cjs');
const { pipeline, citation, meta, writes } = require('./capture-pipeline-host/helpers.cjs');
const { write } = require('./setup-package-lifecycle-fixture.cjs');

async function delayedCapture(current, evidence) {
  const parent = await current.parent();
  const start = current.control.events.length;
  const http = current.provider.requests.length;
  const before = writes(current.control);
  current.control.settings.coordinatorGate = true;
  current.provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit(), { text: 'Blocked fourth.' });
  await current.prompt(parent, 'For future responses, prefer concise Chinese for the delayed capture proof.');
  await current.control.wait((event) => event.phase === 'gate.waiting' && event.sessionID === `coordinator-${parent.id}`);
  const entered = performance.now();
  await delay(31000);
  assert.equal(current.provider.requests.length - http, 1);
  assert.equal(writes(current.control), before);
  assert.deepEqual(current.unwrap(await current.client.session.children({ path: { id: parent.id } })), []);
  current.control.settings.coordinatorGate = false;
  current.control.release(`coordinator-${parent.id}`);
  const review = await current.review(parent, start);
  assert.equal(meta(review).status, 'saved', JSON.stringify(meta(review)));
  const children = current.unwrap(await current.client.session.children({ path: { id: parent.id } }));
  assert.equal(children.length, 2);
  const commit = children.find((child) => child.title.endsWith('commit'));
  await current.control.wait((event) => event.phase === 'generation.blocked' && event.sessionID === commit.id && event.code === 'model_budget');
  const events = current.control.events.slice(start);
  const complete = events.findIndex((event) => event.phase === 'coordinator.complete' && event.sessionID === parent.id);
  const firstCreate = events.findIndex((event) => event.phase === 'capture.sdk' && event.method === 'session.create');
  assert.ok(complete >= 0 && firstCreate > complete);
  assert.equal(events.filter((event) => event.phase === 'generation' && children.some((child) => child.id === event.sessionID)).length, 3);
  assert.equal(current.provider.requests.length - http, 4);
  assert.equal(writes(current.control) - before, 1);
  assert.equal(events.filter((event) => event.phase === 'native.ask').length, 1);
  const receipt = events.find((event) => event.phase === 'remember.result').receipt;
  assert.equal(receipt.readback.status, 'ok');
  assert.equal(meta(review).model_calls, 3);
  assert.equal(meta(review).write_attempts, 1);
  const saved = receipt.readback.results[0].memory;
  const read = await current.cli(['read', String(saved.id), '--placement', saved.placement]);
  assert.equal(read.results[0].memory.content, saved.content);
  evidence.cases.push({ name: 'coordinator_wait_over_30s_then_fresh_capture', wait_ms: performance.now() - entered,
    release_after_ms: 31000, review: meta(review), children, worker_dispatches: 3, native_ask: 1, writes: 1, readback: read,
    complete_event_index: complete, first_child_create_event_index: firstCreate });
  current.provider.responses.length = 0;
}

async function cancelledWait(current, evidence, mode) {
  const parent = await current.parent();
  const start = current.control.events.length;
  const before = writes(current.control);
  const http = current.provider.requests.length;
  current.control.settings.coordinatorGate = true;
  current.control.settings.coordinatorFalse = mode === 'false';
  current.provider.responses.push({ text: 'Confirmed.' });
  await current.prompt(parent, `Prefer concise Chinese for obsolete coordinator ${mode}.`);
  const gate = await current.control.wait((event) => event.phase === 'coordinator.enter' && event.sessionID === parent.id);
  await current.control.wait((event) => event.phase === 'gate.waiting' && event.sessionID === `coordinator-${parent.id}`);
  current.control.settings.coordinatorGate = false;
  if (mode === 'new_input') {
    current.provider.responses.push({ text: 'New input acknowledged.' }, { text: '{"candidates":[]}' });
    await current.prompt(parent, 'New temporary request supersedes the previous input.');
  } else if (mode === 'delete') {
    current.unwrap(await current.client.session.delete({ path: { id: parent.id } }));
    await current.control.wait((event) => event.phase === 'host.event' && event.event.type === 'session.deleted' && event.event.properties.info.id === parent.id);
  }
  current.control.release(`coordinator-${parent.id}`);
  if (mode === 'delete') {
    await current.control.wait((event) => event.phase === 'capture.sdk' && event.method === 'session.get' &&
      event.request.path?.id === parent.id && event.response.error?.name === 'NotFoundError');
    const events = current.control.events.slice(start);
    assert.equal(events.filter((event) => event.phase === 'capture.sdk' && event.method === 'session.create').length, 0);
    assert.equal(events.filter((event) => event.phase === 'native.ask').length, 0);
    assert.equal(current.provider.requests.length - http, 1);
    assert.equal(writes(current.control), before);
    evidence.cases.push({ name: 'coordinator_wait_delete_prevents_obsolete_capture', obsolete_dispatches: 0, writes: 0,
      limitation: 'Deleted parent prevents activity review persistence; completion observed through terminal parent lookup failure.' });
    return;
  }
  const review = await current.control.wait((event) => current.control.events.indexOf(event) >= start && event.phase === 'capture.review' &&
    event.payload.context.session_id === parent.id && event.payload.context.message_id === gate.userID);
  assert.equal(meta(review).reason, { new_input: 'new_input', delete: 'parent_deleted', false: 'coordinator_cancelled' }[mode]);
  assert.equal(meta(review).model_calls, 0);
  assert.equal(meta(review).write_attempts, 0);
  if (mode === 'new_input') await current.control.wait((event) => event.phase === 'capture.review' &&
    event.payload.context.session_id === parent.id && event.payload.context.message_id !== gate.userID);
  else assert.equal(current.provider.requests.length - http, 1);
  assert.equal(writes(current.control), before);
  assert.equal(current.control.events.slice(start).filter((event) => event.phase === 'native.ask').length, 0);
  evidence.cases.push({ name: `coordinator_wait_${mode}_prevents_obsolete_capture`, review: meta(review), obsolete_dispatches: 0, writes: 0 });
  current.provider.responses.length = 0;
  current.control.settings.coordinatorFalse = false;
}

async function multilingualSource(current, evidence) {
  const filename = path.join(current.fixture.project, 'release-route.md');
  for (const [index, text] of ['请帮我配置alpha发布流程', '请帮我配置发布流程', 'Prepare the rollout procedure'].entries()) {
    const content = `# Alpha release\nUse release${index}.sh for alpha only.\nApproval required. Do not use for beta.`;
    write(filename, content);
    const parent = await current.parent();
    const start = current.control.events.length;
    const before = writes(current.control);
    let selected;
    current.provider.responses.push({ tool: 'read', args: { filePath: filename } }, { text: 'Read complete.' }, current.extract((packet) => {
      const source = packet.sources.find((entry) => entry.kind === 'file_content');
      assert.ok(source, 'genuine observed read must survive different task wording');
      selected = source;
      return { candidates: [{ statements: [{ text: content, citations: [citation(source)] }] }] };
    }), current.commit());
    await current.prompt(parent, text);
    const review = await current.review(parent, start);
    assert.equal(meta(review).status, 'saved', JSON.stringify(meta(review)));
    assert.equal(writes(current.control) - before, 1);
    const receipt = current.control.events.slice(start).find((event) => event.phase === 'remember.result').receipt;
    const saved = receipt.readback.results[0].memory;
    const read = await current.cli(['read', String(saved.id), '--placement', saved.placement]);
    assert.ok(read.results[0].memory.content.includes('Approval required. Do not use for beta.'));
    evidence.cases.push({ name: 'observed_route_across_task_wording', request: text, selected_source: selected,
      review: meta(review), writes: 1, readback: read });
    current.provider.responses.length = 0;
  }
}

test('capture integration repairs through both isolated official host surfaces',
  { skip: process.env.MEMOCAP_CAPTURE_E2E !== '1', timeout: 300000 }, async (t) => {
  assert.ok(['0', '1'].includes(process.env.MEMOCAP_CAPTURE_PACKAGED_HOST), 'explicit isolated host required');
  const version = process.env.MEMOCAP_CAPTURE_PACKAGED_HOST === '1' ? '1193' : '1195';
  const destination = path.resolve(__dirname, '../.omo/evidence/capture-expansion');
  const scratch = path.join(destination, `capture-repairs-${version}-${Date.now()}`);
  const evidence = { mode: 'production', entry: 'capture_only', status: 'WORKING', cleanup: {}, cases: [], commands: [],
    limitation: 'Controlled coordinator at public integration seam; maintenance implementation untouched. Local wire results prove mechanism only.' };
  process.stderr.write(`WORKING capture repairs ${version}: isolated package and actual host\n`);
  const current = pipeline(await harness(evidence, scratch));
  try {
    await delayedCapture(current, evidence);
    for (const mode of ['new_input', 'delete', 'false']) await cancelledWait(current, evidence, mode);
    await multilingualSource(current, evidence);
    assert.deepEqual(current.provider.errors, []);
    evidence.status = 'passed_capture_integration_repairs_host';
  } catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
  finally {
    await current.close();
    write(path.join(destination, `capture-integration-repairs-host-${version}.json`), JSON.stringify(evidence, null, 2));
    t.diagnostic(JSON.stringify({ status: evidence.status, cases: evidence.cases.length, cleanup: evidence.cleanup }));
  }
});
