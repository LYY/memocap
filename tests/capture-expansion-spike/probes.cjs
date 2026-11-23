const assert = require('node:assert/strict');
const { writes, idle } = require('../opencode-capture/cases.cjs');

async function probes(current, evidence) {
  for (const [name, proposal, response] of [
    ['malformed_extraction', { text: '{' }, 'invalid_proposal'],
    ['forged_source', current.extract(() => ({ candidates: [{ evidence: [{ sourceId: 'forged', quote: 'Saved.' }] }] })), 'missing_evidence'],
    ['misleading_exit_and_save_claim', { text: '{"candidates":[]}' }, 'no_candidate'],
  ]) {
    const parent = await current.parent();
    const before = writes(current.control);
    current.provider.responses.push({ text: 'Saved successfully. Command exit code 0. Business completed.' }, proposal);
    await current.prompt(parent, `Temporary task ${name}; no independently verified business result.`);
    const review = await current.review(parent);
    assert.equal(review.payload.detail.metadata.reason, response);
    assert.equal(review.payload.detail.metadata.status, 'skipped');
    assert.equal(writes(current.control), before);
    evidence.probes.push({ name, review: review.payload.detail.metadata, native_writes: 0 });
  }
  const parent = await current.parent();
  const before = writes(current.control);
  const start = current.control.events.length;
  current.control.settings.handshakeGate = true;
  current.provider.responses.push({ text: 'Confirmed.' }, current.extract());
  if (evidence.mode === 'scratch_prototype') current.provider.responses.push({ text: '{"supported":true}' });
  current.provider.responses.push(current.commit());
  const original = await current.prompt(parent, 'For future work, always use this cancelled old generation.');
  await current.control.wait((event) => current.control.events.indexOf(event) >= start && event.phase === 'gate.waiting' && event.sessionID === 'handshake');
  const observed = current.control.events.length;
  await current.client.session.abort({ path: { id: parent.id } });
  await current.control.wait((event) => current.control.events.indexOf(event) >= observed && idle(event, parent.id));
  current.control.release('handshake');
  const review = await current.review(parent, start);
  assert.equal(review.payload.detail.metadata.write_attempts, 0);
  assert.equal(writes(current.control), before);
  const children = current.unwrap(await current.client.session.children({ path: { id: parent.id } }));
  await current.control.wait((event) => event.phase === 'remember.result' && children.some((child) => child.id === event.sessionID));
  current.control.settings.handshakeGate = false;
  const resumeStart = current.control.events.length;
  current.provider.responses.push({ text: 'Temporary fresh input.' }, { text: '{"candidates":[]}' });
  await current.prompt(parent, 'Resume with a new unrelated temporary task.');
  const resumed = await current.review(parent, resumeStart);
  assert.equal(resumed.payload.detail.metadata.reason, 'no_candidate');
  assert.notEqual(resumed.payload.context.message_id, original.info.parentID);
  assert.equal(writes(current.control), before);
  evidence.probes.push({ name: 'real_cancel_then_resume_old_observations_cannot_revive_writer',
    cancelled: review.payload.detail.metadata, resumed: resumed.payload.detail.metadata, native_writes: 0 });

  const staleParent = await current.parent();
  const staleStart = current.control.events.length;
  current.control.settings.handshakeGate = true;
  current.provider.responses.push({ text: 'Confirmed.' }, current.extract());
  if (evidence.mode === 'scratch_prototype') current.provider.responses.push({ text: '{"supported":true}' });
  current.provider.responses.push(current.commit());
  const stalePrompt = await current.prompt(staleParent, 'For future work, always use this superseded generation.');
  await current.control.wait((event) => current.control.events.indexOf(event) >= staleStart && event.phase === 'gate.waiting' && event.sessionID === 'handshake');
  current.control.settings.handshakeGate = false;
  current.provider.responses.push({ text: 'New input.' }, { text: '{"candidates":[]}' });
  await current.prompt(staleParent, 'New input replaces the old goal.');
  current.control.release('handshake');
  const stale = await current.control.wait((event) => event.phase === 'capture.review' &&
    event.payload.context.session_id === staleParent.id && event.payload.context.message_id === stalePrompt.info.parentID);
  assert.equal(stale.payload.detail.metadata.reason, 'new_input');
  const staleChildren = current.unwrap(await current.client.session.children({ path: { id: staleParent.id } }));
  const blocked = await current.control.wait((event) => current.control.events.indexOf(event) >= staleStart &&
    event.phase === 'remember.result' && staleChildren.some((child) => child.title.endsWith('commit') && child.id === event.sessionID));
  const fresh = await current.control.wait((event) => event.phase === 'capture.review' && event.payload.context.session_id === staleParent.id &&
    event.payload.context.message_id !== stale.payload.context.message_id);
  assert.equal(fresh.payload.detail.metadata.reason, 'no_candidate');
  assert.equal(blocked.receipt.status, 'blocked');
  assert.equal(blocked.receipt.error.code, 'new_input');
  assert.equal(writes(current.control), before);
  evidence.probes.push({ name: 'new_user_invalidates_stale_generation_before_spawn', review: stale.payload.detail.metadata,
    remember: blocked.receipt, fresh: fresh.payload.detail.metadata, native_writes: 0 });
}
module.exports = { probes };
