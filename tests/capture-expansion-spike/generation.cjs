const assert = require('node:assert/strict');

async function generation(current, evidence) {
  const parent = await current.parent();
  const start = current.control.events.length;
  const requestStart = current.provider.requests.length;
  current.provider.responses.push({ text: 'Confirmed.' }, current.extract());
  if (evidence.mode === 'scratch_prototype') current.provider.responses.push({ text: '{"supported":true}' });
  current.provider.responses.push(current.commit(), { text: 'Misleading summary must never decide saved status.' });
  await current.prompt(parent, 'For future responses, use concise Chinese for the three dispatch spike.');
  const review = await current.review(parent, start);
  const children = current.unwrap(await current.client.session.children({ path: { id: parent.id } }));
  const commit = children.find((child) => child.title.endsWith('commit'));
  const extraction = children.find((child) => child.title.endsWith('extract'));
  const meta = review.payload.detail.metadata;
  assert.equal(children.length, 2);
  assert.equal(new Set(children.map((child) => child.id)).size, 2);
  const workerCalls = current.control.events.slice(start).filter((event) => event.phase === 'generation' && children.some((child) => child.id === event.sessionID));
  const extractCalls = workerCalls.filter((event) => event.sessionID === extraction.id).length;
  if (evidence.mode === 'negative_control_0.6.0') {
    assert.equal(extractCalls, 1);
    assert.throws(() => assert.equal(extractCalls, 2), { code: 'ERR_ASSERTION' });
    evidence.support_contract = { result: 'RED_support_generation_missing', actual: extractCalls, expected: 2 };
  } else if (evidence.mode === 'scratch_prototype') {
    assert.equal(extractCalls, 2);
    await current.control.wait((event) => event.phase === 'generation.blocked' && event.sessionID === commit.id && event.code === 'model_budget');
    const support = current.provider.requests.slice(requestStart)[2];
    assert.deepEqual(support.body.tools ?? [], []);
    assert.equal(current.provider.responses.length, 1);
    evidence.support_contract = { result: 'GREEN_support_then_commit_summary_blocked', actual: extractCalls, expected: 2 };
  } else {
    assert.equal(extractCalls, 1);
    evidence.support_contract = { result: 'unchanged_model_proposal_no_support_slice', actual: extractCalls };
  }
  const events = current.control.events.slice(start);
  if (evidence.mode !== 'negative_control_0.6.0') assert.equal(events.filter((event) => event.phase === 'capture.sdk' &&
    event.method === 'session.messages' && event.request.path.id === parent.id).length, 0);
  const result = events.find((event) => event.phase === 'remember.result').receipt;
  assert.equal(events.filter((event) => event.phase === 'generation' && event.sessionID === parent.id).length, 1);
  assert.equal(workerCalls.length, 3);
  assert.equal(current.provider.requests.length - requestStart, 4);
  assert.equal(events.filter((event) => event.phase === 'native.write.spawn').length, 1);
  assert.equal(events.filter((event) => event.phase === 'native.ask').length, 1);
  assert.equal(result.readback.status, 'ok');
  assert.equal(meta.status, 'saved');
  assert.equal(meta.model_calls, 3);
  assert.equal(meta.write_attempts, 1);
  assert.equal(review.exit_code, 0);
  const activity = await current.cli(['activity', 'show', review.payload.operation_id]);
  assert.deepEqual(activity.events.find((event) => event.detail.phase === 'capture_review').detail.metadata, meta);
  const saved = result.readback.results[0].memory;
  const read = await current.cli(['read', String(saved.id), '--placement', saved.placement]);
  assert.equal(read.results[0].memory.content, saved.content);
  assert.equal(read.results[0].memory.tags, saved.tags);
  evidence.counts = { parent_http: 1, worker_http: workerCalls.length, child_sessions: children.length,
    native_write: 1, native_ask: 1, extraction_generations: extractCalls, commit_generations: 3 - extractCalls };
  evidence.review = review;
  evidence.activity = activity;
  evidence.readback = read;
  evidence.provider_requests = current.provider.requests.slice(requestStart);
  evidence.events = events.filter((event) => event.phase !== 'host.event');
  evidence.children = children;
  current.provider.responses.length = 0;
}
module.exports = { generation };
