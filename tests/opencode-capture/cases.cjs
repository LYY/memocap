const assert = require('node:assert/strict');

const meta = (event) => event.payload.detail.metadata;
const writes = (control) => control.events.filter((event) => event.phase === 'native.write.spawn').length;
const idle = (event, id) => event.phase === 'host.event' && event.event.type === 'session.status' &&
  event.event.properties.sessionID === id && event.event.properties.status.type === 'idle';

async function handshakeAbort(current, evidence) {
  const { provider, control, client, unwrap, cli } = current;
  control.settings.handshakeGate = true;
  const parent = await current.parent();
  const before = writes(control);
  provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit(), { text: 'Stopped.' });
  await current.prompt(parent, 'For future work, always use the handshake cancellation fixture.');
  await control.wait((event) => event.phase === 'gate.waiting' && event.sessionID === 'handshake');
  const observed = control.events.length;
  assert.equal(unwrap(await client.session.abort({ path: { id: parent.id } })), true);
  await control.wait((event) => control.events.indexOf(event) >= observed && idle(event, parent.id));
  control.release('handshake');
  const review = await current.review(parent);
  const child = (await client.session.children({ path: { id: parent.id } })).data.find((entry) => entry.title.endsWith('commit'));
  await control.wait((event) => event.phase === 'remember.result' && event.sessionID === child.id);
  assert.equal(meta(review).status, 'skipped');
  assert.equal(meta(review).reason, 'ambiguous_idle');
  assert.equal(meta(review).write_attempts, 0);
  assert.equal(writes(control), before);
  const rows = await cli(['list', '--repo', current.fixture.project]);
  assert.equal(rows.results.some((entry) => entry.memory.content.includes('handshake cancellation fixture')), false);
  const count = control.events.filter((event) => event.phase === 'capture.review' && event.payload.context.session_id === parent.id).length;
  const again = control.events.length;
  await client.session.abort({ path: { id: parent.id } });
  await control.wait((event) => control.events.indexOf(event) >= again && idle(event, parent.id));
  assert.equal(control.events.filter((event) => event.phase === 'capture.review' && event.payload.context.session_id === parent.id).length, count);
  control.settings.handshakeGate = false;
  provider.responses.length = 0;
  evidence.cases.push({ name: 'actual_idle_parent_abort_during_native_version', review: meta(review), zero_write_spawn: true, no_row: true, no_retry: true });
}

async function replayIdle(current, evidence) {
  current.control.settings.replayIdle = true;
  const parent = await current.parent();
  const before = writes(current.control);
  current.provider.responses.push({ text: 'Confirmed.' });
  await current.prompt(parent, 'For future work, always use the same status replay fixture.');
  const result = await current.review(parent);
  assert.equal(meta(result).reason, 'ambiguous_idle');
  assert.equal(writes(current.control), before);
  assert.ok(current.control.events.some((event) => event.phase === 'controlled.same_type_idle_replay' && event.sessionID === parent.id));
  current.control.settings.replayIdle = false;
  evidence.cases.push({ name: 'controlled_same_type_idle_replay_fail_closed', review: meta(result) });
}

async function rejected(current, evidence) {
  for (const [name, text, change, reason] of [
    ['no_durable_model_policy', 'This task exited with zero status.', () => ({ candidates: [] }), 'no_candidate'],
    ['quoted_assistant_model_policy', 'The assistant wrote: always use this provider.', () => ({ candidates: [] }), 'no_candidate'],
    ['secret', 'For future work, always use api_key: synthetic-secret-value.', undefined, 'secret'],
    ['unsupported_source', 'For future work, always use Chinese for this unsupported source test.', () => ({ candidates: [{ evidence: [{ sourceId: 'assistant-only', quote: 'Business succeeded.' }] }] }), 'missing_evidence'],
    ['no_candidate', 'For future work, always use Chinese for this empty candidate test.', () => ({ candidates: [] }), 'no_candidate'],
  ]) {
    const parent = await current.parent();
    const before = writes(current.control);
    current.provider.responses.push({ text: 'Confirmed.' });
    if (name !== 'secret') current.provider.responses.push(current.extract(change));
    await current.prompt(parent, text);
    const result = await current.review(parent);
    assert.equal(meta(result).reason, reason);
    assert.equal(meta(result).write_attempts, 0);
    assert.equal(writes(current.control), before);
    evidence.cases.push({ name, review: meta(result) });
  }
}

async function mismatchAndBudget(current, evidence) {
  const mismatch = await current.parent();
  const before = writes(current.control);
  current.provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit((args) => ({ content: `${args.content} invented` })), { text: 'Stopped.' });
  await current.prompt(mismatch, 'For future work, always use the candidate mismatch fixture.');
  const rejected = await current.review(mismatch);
  assert.equal(meta(rejected).reason, 'candidate_mismatch');
  assert.equal(writes(current.control), before);
  evidence.cases.push({ name: 'mismatched_candidate', review: meta(rejected) });

  const budget = await current.parent();
  current.provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit(),
    { tool: 'memocap_remember', args: { content: 'second unbound write' } });
  await current.prompt(budget, 'For future work, always use the bounded generation fixture.');
  const result = await current.review(budget);
  assert.equal(meta(result).status, 'saved');
  assert.equal(meta(result).model_calls, 3);
  assert.equal(meta(result).tool_calls, 2);
  assert.equal(writes(current.control), before + 1);
  const child = (await current.client.session.children({ path: { id: budget.id } })).data.find((entry) => entry.title.endsWith('commit'));
  await current.control.wait((event) => event.phase === 'generation.blocked' && event.sessionID === child.id && event.code === 'model_budget');
  evidence.cases.push({ name: 'second_tool_and_three_dispatch_budget', review: meta(result) });
}

async function cancelAfterCommit(current, evidence, childAbort = false) {
  const { provider, control, client } = current;
  const parent = await current.parent();
  const gateStart = control.events.length;
  control.settings.afterWriteGate = true;
  provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit(), { text: 'Saved.' });
  await current.prompt(parent, `For future work, always use the ${childAbort ? 'child' : 'parent'} write then cancellation readback fixture.`);
  await control.wait((event) => control.events.indexOf(event) >= gateStart && event.phase === 'gate.waiting' && event.sessionID === 'after-write');
  const children = (await client.session.children({ path: { id: parent.id } })).data;
  const cancelledID = childAbort ? children.find((child) => child.title.endsWith('commit')).id : parent.id;
  const observed = control.events.length;
  const aborting = client.session.abort({ path: { id: cancelledID } });
  await control.wait((event) => control.events.indexOf(event) >= observed && idle(event, cancelledID));
  control.release('after-write');
  await aborting;
  const result = await current.review(parent);
  assert.equal(meta(result).status, 'saved');
  const receipt = await control.wait((event) => event.phase === 'remember.result' && children.some((child) => child.id === event.sessionID));
  assert.equal(receipt.receipt.readback.status, 'ok');
  control.settings.afterWriteGate = false;
  if (childAbort) provider.responses.length = 0;
  evidence.cases.push({ name: childAbort ? 'actual_child_abort_after_commit_readback' : 'cancel_after_actual_commit_independent_readback', review: meta(result) });
}

module.exports = { handshakeAbort, replayIdle, rejected, mismatchAndBudget, cancelAfterCommit, meta, writes, idle };
