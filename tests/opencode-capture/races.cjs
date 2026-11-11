const assert = require('node:assert/strict');
const { meta, writes } = require('./cases.cjs');

async function duplicate(current, evidence) {
  const { control, provider, cli } = current;
  const parent = await current.parent();
  const text = 'Report finished.\n\nI prefer Chinese for the exact canonical duplicate fixture.\nSource: user-authored reference';
  const before = writes(control);
  provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit(), { text: 'Saved.' });
  await current.prompt(parent, text);
  const first = await current.review(parent);
  assert.equal(meta(first).status, 'saved');
  const observed = control.events.length;
  provider.responses.push({ text: 'Confirmed again.' }, current.extract());
  await current.prompt(parent, text);
  const result = await current.review(parent, observed);
  assert.equal(meta(result).reason, 'duplicate_body');
  assert.notEqual(first.payload.context.message_id, result.payload.context.message_id);
  assert.equal(writes(control), before + 1);
  const rows = await cli(['list', '--repo', current.fixture.project]);
  const saved = rows.results.filter((entry) => entry.memory.content.startsWith(text));
  assert.equal(saved.length, 1);
  assert.match(saved[0].memory.tags, /^memocap-capture-[a-f0-9]{64}$/);
  evidence.cases.push({ name: 'same_knowledge_two_distinct_turns_one_native_save', review: meta(result), original_source_line_retained: true });
}

async function newInput(current, evidence) {
  const { provider, control, client, unwrap } = current;
  control.settings.handshakeGate = true;
  const parent = await current.parent();
  const before = writes(control);
  const gateStart = control.events.length;
  provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit());
  const original = await current.prompt(parent, 'For future responses, always use the superseded input fixture.');
  await control.wait((event) => control.events.indexOf(event) >= gateStart && event.phase === 'gate.waiting' && event.sessionID === 'handshake');
  const observed = control.events.length;
  provider.responses.push({ text: 'Second input completed.' }, { text: '{"candidates":[]}' });
  await current.prompt(parent, 'This is a new real input with temporary state.');
  await control.wait((event) => control.events.indexOf(event) >= observed && event.phase === 'host.event' &&
    event.event.type === 'message.updated' && event.event.properties.info.role === 'user' && event.event.properties.info.sessionID === parent.id);
  control.release('handshake');
  const result = await control.wait((event) => event.phase === 'capture.review' && event.payload.context.session_id === parent.id &&
    event.payload.context.message_id === original.info.parentID);
  assert.equal(meta(result).reason, 'new_input');
  const children = unwrap(await client.session.children({ path: { id: parent.id } }));
  const commit = children.find((child) => child.title.endsWith('commit'));
  await control.wait((event) => event.phase === 'remember.result' && event.sessionID === commit.id);
  await control.wait((event) => event.phase === 'capture.review' && event.payload.context.session_id === parent.id &&
    event.payload.context.message_id !== result.payload.context.message_id);
  assert.equal(writes(control), before);
  control.settings.handshakeGate = false;
  evidence.cases.push({ name: 'new_real_input_before_spawn', review: meta(result) });
}

async function nativeDenial(current, evidence) {
  const { control, provider, client, unwrap } = current;
  const parent = await current.parent('ask');
  const before = writes(control);
  provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit(), { text: 'Denied.' });
  await current.prompt(parent, 'For future responses, always use the actual native ask rejection fixture.');
  const asked = await control.wait((event) => event.phase === 'host.event' &&
    ['permission.asked', 'permission.updated'].includes(event.event.type) && event.event.properties.permission === 'memocap_remember');
  const request = asked.event.properties;
  unwrap(await client.postSessionIdPermissionsPermissionId({ path: { id: request.sessionID, permissionID: request.id }, body: { response: 'reject' } }));
  const result = await current.review(parent);
  assert.equal(meta(result).status, 'denied');
  assert.equal(meta(result).reason, 'native_permission_denied');
  assert.equal(writes(control), before);
  evidence.cases.push({ name: 'true_tool_context_native_ask_reject', review: meta(result) });
}

async function unknownReceipt(current, evidence) {
  const { provider, control, cli } = current;
  control.settings.unknownWrite = true;
  const parent = await current.parent();
  const before = writes(control);
  provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit(), { text: 'Unknown result. Do not retry.' });
  await current.prompt(parent, 'For future responses, always use the unknown receipt fixture.');
  const result = await current.review(parent);
  assert.equal(meta(result).status, 'unknown');
  assert.deepEqual(meta(result).memory_ids, []);
  assert.equal(meta(result).write_attempts, 1);
  assert.equal(writes(control), before + 1);
  const rows = await cli(['list', '--repo', current.fixture.project]);
  assert.equal(rows.results.filter((entry) => entry.memory.content.includes('unknown receipt fixture')).length, 1);
  control.settings.unknownWrite = false;
  evidence.cases.push({ name: 'unknown_no_id_is_never_replayed', review: meta(result), actual_row_exists: true });
}

async function parentError(current, evidence) {
  const parent = await current.parent();
  const before = writes(current.control);
  const requests = current.provider.requests.length;
  const response = await current.client.session.prompt({ path: { id: parent.id }, body: {
    model: { providerID: 'wire', modelID: 'missing-model' }, agent: 'build',
    parts: [{ type: 'text', text: 'For future work, always use the invalid model error fixture.' }],
  } });
  assert.ok(response.error);
  await current.control.wait((event) => event.phase === 'host.event' && event.event.type === 'session.error' && event.event.properties.sessionID === parent.id);
  const children = current.unwrap(await current.client.session.children({ path: { id: parent.id } }));
  assert.equal(children.length, 0);
  assert.equal(current.provider.requests.length, requests);
  assert.equal(writes(current.control), before);
  evidence.cases.push({ name: 'actual_parent_model_error_has_no_capture_children_or_write', provider_requests: 0, writes: 0 });
}

module.exports = { duplicate, newInput, nativeDenial, unknownReceipt, parentError };
