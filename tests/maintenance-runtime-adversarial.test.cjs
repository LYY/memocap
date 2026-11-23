const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./maintenance-integration/fixture.cjs');
function update(data) {
  const source = data.evidence[0];
  return { action: 'update', target: data.used[0].use_id, content: 'new route',
    citations: [{ source_id: source.source_id, quote: 'Check current route' }] };
}
async function finish(host) {
  host.complete();
  await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-1' });
  return host.runtime.maintenanceStatus('A');
}
test('a handle from a different parent cannot attest adoption', async (context) => {
  const host = await fixture(context);
  const read = await host.read();
  host.toolContext.sessionID = 'B';
  const result = await host.use(read.maintenance_read);
  assert.equal(result.error.code, 'native_call_required');
  assert.equal(host.writes.length, 0);
});
test('a prior task receipt expires when a new user task is observed', async (context) => {
  const host = await fixture(context);
  const read = await host.read();
  host.maintenance.observe({ sessionID: 'A', agent: 'build' }, { message: { id: 'user-2', role: 'user' },
    parts: [{ id: 'part-2', type: 'text', text: 'Another actual task' }] });
  const result = await host.use(read.maintenance_read);
  assert.notEqual(result.status, 'used');
  assert.equal(host.writes.length, 0);
});
test('a revised hash cannot reuse an original opaque receipt', async (context) => {
  const host = await fixture(context);
  const read = await host.read();
  const result = await host.use({ ...read.maintenance_read, content_hash: '0'.repeat(64) });
  assert.equal(result.error.code, 'reference_mismatch');
});
test('a receipt can declare adoption only once', async (context) => {
  const host = await fixture(context);
  const read = await host.read();
  await host.use(read.maintenance_read);
  const result = await host.use(read.maintenance_read);
  assert.notEqual(result.status, 'used');
});
test('secret-bearing full records receive no adoption handle', async (context) => {
  const host = await fixture(context);
  host.records[0].content = 'API token: sk-proj-123456789012345678901234567890';
  assert.equal((await host.read()).maintenance_read, undefined);
});
for (const unavailable of ['404 Not Found', 'ETIMEDOUT', 'permission denied', 'offline']) {
  test(`a current task ${unavailable} observation remains unknown without generations or writes`, async (context) => {
    const host = await fixture(context);
    await host.use((await host.read()).maintenance_read);
    host.modelDecision = update;
    host.maintenance.event({ event: { type: 'message.updated', properties: { info: {
      id: 'assistant-tool', sessionID: 'A', parentID: 'user-1', role: 'assistant' } } } });
    host.maintenance.event({ event: { type: 'message.part.updated', properties: { part: {
      id: 'failed-source', sessionID: 'A', messageID: 'assistant-tool', type: 'tool', tool: 'read',
      state: { status: 'error', input: { filePath: '/task/source' }, error: unavailable } } } } });
    const summary = await finish(host);
    assert.equal(summary.status, 'unknown');
    assert.equal(summary.model_calls, 0);
    assert.equal(host.writes.length, 0);
  });
}
test('a source removal invalidates the task before review', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  host.maintenance.event({ event: { type: 'message.part.removed', properties: { sessionID: 'A', partID: 'user-part' } } });
  host.complete();
  assert.equal(await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-1' }), false);
  assert.equal(host.requests.length, 0);
});
test('a fingerprint supplied by an unrelated support assessment rejects a proposal', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  host.modelDecision = update;
  host.supportBinding = (binding) => ({ ...binding, decision_fingerprint: '0'.repeat(64) });
  assert.equal((await finish(host)).reason, 'review_mismatch');
  assert.equal(host.writes.length, 0);
});
test('a keep assessment consumes no write and cannot mark organized freshness', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  host.modelDecision = (packet) => ({ action: 'keep', target: packet.used[0].use_id });
  assert.equal((await finish(host)).status, 'keep');
  assert.equal(host.writes.length, 0);
  assert.equal(host.records[0].organized_at, null);
});
test('an inventory record without a used handle cannot participate in a merge', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  host.modelDecision = (packet) => ({ ...update(packet), action: 'merge', sources: ['inventory-only'] });
  assert.equal((await finish(host)).status, 'blocked');
  assert.equal(host.requests.length, 1);
  assert.equal(host.writes.length, 0);
});
test('extraction and support both disable all tools and a completed task reviews once', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  host.modelDecision = update;
  await finish(host);
  await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-1' });
  assert.equal(host.requests.length, 2);
  for (const request of host.requests) assert.deepEqual(Object.values(request.body.tools), [false, false, false]);
});
test('a native parent permission revision invalidates the in-flight review', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  host.modelDecision = (packet) => {
    host.maintenance.event({ event: { type: 'session.updated', properties: { info: { id: 'A',
      permission: [{ permission: 'memocap_maintain', pattern: '*', action: 'deny' }] } } } });
    return update(packet);
  };
  assert.equal((await finish(host)).reason, 'permission_changed');
  assert.equal(host.requests.length, 1);
  assert.equal(host.writes.length, 0);
});
test('status and why retain the bounded concrete maintenance proposal', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  host.modelDecision = update;
  const summary = await finish(host);
  const status = await host.operations.inspect('status', '', host.toolContext);
  const why = await host.operations.inspect('why', '', host.toolContext);
  assert.equal(status.maintenance.proposal.proposal_id, summary.proposal.proposal_id);
  assert.deepEqual(why.maintenance, status.maintenance);
  assert.ok(Buffer.byteLength(JSON.stringify(status.maintenance)) < 4096);
  assert.equal(JSON.stringify(status.maintenance).includes('old route'), false);
});
test('secret fragments across one native user message prevent read registration', async (context) => {
  const host = await fixture(context);
  host.maintenance.observe({ sessionID: 'A', agent: 'build' }, { message: { id: 'user-secret', role: 'user' }, parts: [
    { id: 'secret-a', type: 'text', text: 'pass' }, { id: 'secret-b', type: 'text', text: 'word=fixture-secret' }] });
  assert.equal((await host.read()).maintenance_read, undefined);
});
test('late native user reclassification invalidates adopted source evidence', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  host.maintenance.event({ event: { type: 'message.part.updated', properties: { part: {
    id: 'user-part', sessionID: 'A', messageID: 'user-1', type: 'text', text: 'Check current route', ignored: true } } } });
  host.complete();
  assert.equal(await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-1' }), false);
  assert.equal(host.requests.length, 0);
});
test('a task cannot complete while an actual tool remains pending', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  host.maintenance.event({ event: { type: 'message.updated', properties: { info: {
    id: 'pending-assistant', sessionID: 'A', parentID: 'user-1', role: 'assistant' } } } });
  host.maintenance.event({ event: { type: 'message.part.updated', properties: { part: {
    id: 'pending-command', sessionID: 'A', messageID: 'pending-assistant', type: 'tool', tool: 'bash',
    state: { status: 'pending', input: { command: 'fixture command' } } } } } });
  host.complete();
  assert.equal(await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-1' }), false);
  assert.equal(host.requests.length, 0);
});
test('unrelated native tools cannot exhaust full-read adoption bindings', async (context) => {
  const host = await fixture(context);
  for (let index = 0; index < 140; index++) host.maintenance.before({ sessionID: 'A', tool: 'memocap_recall', callID: `recall-${index}` },
    { args: { query: `unrelated query ${index}` } });
  const result = await host.use((await host.read()).maintenance_read);
  assert.equal(result.status, 'used');
});
