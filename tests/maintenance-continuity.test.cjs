const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./maintenance-integration/fixture.cjs');
const { snapshot } = require('./maintenance-fixture.cjs');

const citation = (source) => ({ source_id: source.source_id, quote: source.text });
function followup(host, text = 'Continue checking the same alpha route; current authority independently verifies the new route.') {
  host.maintenance.observe({ sessionID: 'A', agent: 'build', model: { providerID: 'wire', modelID: 'wire-model' } }, {
    message: { id: 'user-2', role: 'user' }, parts: [{ id: 'followup', type: 'text', text }] });
  host.maintenance.event({ event: { type: 'message.updated', properties: { info: {
    id: 'assistant-2', sessionID: 'A', parentID: 'user-2', role: 'assistant', finish: 'stop', time: { completed: 43 } } } } });
}
async function first(host) {
  await host.use((await host.read()).maintenance_read);
  host.complete();
  await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-1' });
}
test('same-task follow-up independently reviews prior adoption without another read/use', async (context) => {
  const host = await fixture(context);
  await first(host);
  host.modelDecision = (packet) => ({ action: 'update', target: packet.used[0].use_id, content: 'new route; alpha only',
    citations: packet.evidence.map(citation) });
  host.continuity = (packet) => ({ status: 'same_task', goal: 'check route', object: 'route', environment: 'alpha',
    citations: packet.evidence.map(citation) });
  followup(host);
  await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-2' });
  const summary = host.runtime.maintenanceStatus('A');
  assert.equal(summary.status, 'proposal');
  assert.equal(summary.model_calls, 2);
  assert.equal(host.requests.length, 3);
  const support = JSON.parse(host.requests.at(-1).body.parts[0].text);
  assert.deepEqual(support.continuity.citations.find((entry) => entry.source_id === 'followup'), {
    source_id: 'followup', content_hash: require('./maintenance-fixture.cjs').hash(support.evidence.at(-1).text),
    start: 0, end: 95, quote: 'Continue checking the same alpha route; current authority independently verifies the new route.',
  });
  assert.equal(host.writes.length, 0);
});

test('failed old access does not veto complete later replacement evidence', async (context) => {
  const host = await fixture(context);
  await host.use((await host.read()).maintenance_read);
  const event = (type, properties) => host.maintenance.event({ event: { type, properties } });
  event('message.updated', { info: { id: 'authority', sessionID: 'A', parentID: 'user-1', role: 'assistant' } });
  event('message.part.updated', { part: { id: 'old', sessionID: 'A', messageID: 'authority', type: 'tool', tool: 'read',
    state: { status: 'error', input: { filePath: '/synthetic/old.md' }, error: '404 Not Found' } } });
  const text = 'Current authority: new route replaces old route; approval required and alpha only.';
  event('message.part.updated', { part: { id: 'replacement', sessionID: 'A', messageID: 'authority', type: 'tool', tool: 'read',
    state: { status: 'completed', time: { end: 42 }, input: { filePath: '/synthetic/docs/current.md' },
      output: `<path>/synthetic/docs/current.md</path>\n<type>file</type>\n<content>\n1: ${text}\n\n(End of file - total 1 lines)\n</content>`,
      metadata: { truncated: false, display: { type: 'file', path: '/synthetic/docs/current.md', text, lineStart: 1, lineEnd: 1, totalLines: 1, truncated: false } } } } });
  host.modelDecision = (packet) => ({ action: 'update', target: packet.used[0].use_id, content: text,
    citations: [citation(packet.evidence.find((source) => source.source_id === 'replacement'))] });
  host.complete();
  await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-1' });
  assert.equal(host.runtime.maintenanceStatus('A').status, 'proposal');
  assert.equal(host.requests.length, 2);
  assert.equal(JSON.parse(host.requests[1].body.parts[0].text).evidence.some((source) => source.outcome === 'missing'), true);
});

test('a long-lived public maintenance runtime can complete more than 128 reviews', async (context) => {
  const host = await fixture(context);
  for (let index = 0; index < 130; index++) {
    const userID = `long-user-${index}`;
    host.maintenance.observe({ sessionID: 'A', agent: 'build', model: { providerID: 'wire', modelID: 'wire-model' } }, {
      message: { id: userID, role: 'user' }, parts: [{ id: `long-part-${index}`, type: 'text', text: 'Check alpha route' }] });
    await host.use((await host.read()).maintenance_read);
    host.maintenance.event({ event: { type: 'message.updated', properties: { info: {
      id: `long-assistant-${index}`, sessionID: 'A', parentID: userID, role: 'assistant', finish: 'stop', time: { completed: index + 1 } } } } });
    await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID });
    assert.equal(host.runtime.maintenanceStatus('A').reason, 'no_revision', `review ${index}`);
  }
});

for (const reason of ['unknown', 'unsupported', 'current-only-citation', 'model-offsets', 'model-hash', 'changed-snapshot', 'expired']) {
  test(`prior adoption is ineligible after ${reason}`, async (context) => {
    let now = 0;
    const host = await fixture(context, { clock: () => now });
    await first(host);
    host.modelDecision = (packet) => ({ action: 'update', target: packet.used[0].use_id, content: 'new route', citations: packet.evidence.map(citation) });
    host.continuity = (packet) => reason === 'unknown' ? { status: 'unknown' } : { status: 'same_task', goal: 'check route', object: 'route', environment: 'alpha',
      citations: (reason === 'current-only-citation' ? packet.evidence.filter((entry) => entry.source_id === 'followup') : packet.evidence)
        .map((source) => ({ ...citation(source),
          ...(reason === 'model-offsets' ? { start: 0, end: source.text.length } : {}),
          ...(reason === 'model-hash' ? { content_hash: source.content_hash } : {}),
        })) };
    if (reason === 'unsupported') host.continuitySupport = 'unsupported';
    if (reason === 'changed-snapshot') host.records[0].tags = 'changed';
    if (reason === 'expired') now = 300001;
    followup(host);
    await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-2' });
    assert.notEqual(host.runtime.maintenanceStatus('A').status, 'proposal');
    if (reason === 'model-offsets' || reason === 'model-hash') assert.equal(host.runtime.maintenanceStatus('A').reason, 'invalid_request');
    assert.equal(host.writes.length, 0);
  });
}

for (const relation of ['unknown', 'new_task', 'environment_changed', 'same_task', 'changed-snapshot']) {
  test(`current adoption remains independently eligible when prior continuity is ${relation}`, async (context) => {
    const host = await fixture(context);
    await first(host);
    host.records.push(snapshot(8, 'old route; beta only'));
    if (relation === 'changed-snapshot') host.records[0].tags = 'changed';
    followup(host, 'Current beta authority replaces the route; preserve beta only.');
    host.toolContext.messageID = 'assistant-2';
    await host.use((await host.read(8)).maintenance_read);
    host.modelDecision = (packet) => ({ action: 'update', target: packet.used.find((entry) => entry.snapshot.id === 8).use_id,
      content: 'new route; beta only', citations: packet.evidence.filter((entry) => entry.source_id === 'followup').map(citation) });
    host.continuity = () => ({ status: relation === 'same_task' ? 'same_task' : 'unknown' });
    await host.maintenance.coordinator.beforeReview({ parentID: 'A', userID: 'user-2' });
    assert.equal(host.runtime.maintenanceStatus('A').status, 'proposal');
    const support = JSON.parse(host.requests.at(-1).body.parts[0].text);
    assert.equal(support.stage, 'support');
    assert.deepEqual(support.used.map((entry) => entry.snapshot.id), [8]);
    assert.deepEqual(support.evidence.map((entry) => entry.source_id), ['followup']);
    assert.equal(support.continuity, undefined);
    assert.equal(host.writes.length, 0);
  });
}
