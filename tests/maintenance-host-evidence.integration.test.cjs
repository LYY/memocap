const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { maintenanceHost } = require('./maintenance-integration/host.cjs');
const { mutationTask } = require('./maintenance-integration/mutations.cjs');
const { usedTask, review, spawns, content } = require('./maintenance-integration/scenarios.cjs');
const version = process.env.MEMOCAP_MAINTENANCE_VERSION ?? '1.19.5';
const evidenceDir = process.env.MEMOCAP_MAINTENANCE_EVIDENCE_DIR ?? path.resolve(__dirname, '../.omo/evidence/capture-expansion');
function scenario(name, options, run) {
  test(name, { skip: process.env.MEMOCAP_MAINTENANCE_HOST !== '1', timeout: 90000 }, async (context) => {
    const evidence = { version, name, cleanup: {}, commands: [] };
    let host;
    context.after(async () => {
      if (host) { evidence.events = host.control.events; evidence.requests = host.provider.requests; await host.close(); }
      fs.writeFileSync(path.join(evidenceDir, `post-use-${name}-${version}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    });
    host = await maintenanceHost(version, evidence, options);
    await run(host, evidence);
  });
}
scenario('unrelated-source-edit', {}, async (host, evidence) => {
  const filePath = path.join(host.root, 'project/task-source.txt');
  fs.writeFileSync(filePath, 'route is /v1\nUnrelated paragraph: initial.\n');
  const before = content(host);
  const parent = await host.parent();
  usedTask(host, { action: 'keep', observations: [{ tool: 'read', args: { filePath } }, { tool: 'read', get args() {
    fs.writeFileSync(filePath, 'route is /v1\nUnrelated paragraph: revised.\n');
    return { filePath };
  } }] });
  await host.prompt(parent, 'Read the task source twice. The route entry stays /v1; only an unrelated paragraph changes.');
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.status, 'keep');
  assert.deepEqual(content(host), before);
  assert.equal(spawns(host).length, 0);
  await host.captureDone(parent);
});
scenario('source-missing', {}, async (host, evidence) => {
  const parent = await host.parent();
  usedTask(host, { unknown: true, observations: [{ tool: 'read', args: { filePath: path.join(host.root, 'project/source-missing.txt') } }] });
  await host.prompt(parent, 'Use the adopted memory and read the current task source. A missing source is unknown.');
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.status, 'unknown');
  assert.equal(evidence.result.model_calls, 0);
  assert.equal(spawns(host).length, 0);
  assert.equal(content(host).organized_at, null);
  await host.captureDone(parent);
});
scenario('full-native-input', { agentPrompt: 'Large isolated agent instruction. '.repeat(2400) }, async (host, evidence) => {
  const parent = await host.parent();
  usedTask(host);
  await host.prompt(parent, 'Use the adopted record, then refuse maintenance when the full native model input is over budget.');
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.reason, 'input_budget');
  assert.equal(host.provider.requests.length, 3);
  assert.equal(spawns(host).length, 0);
  assert.ok(host.control.events.some((event) => event.phase === 'input.blocked' && event.code === 'input_budget'));
  await host.captureDone(parent);
});
scenario('native-merge', { permission: (pattern) => ({ [pattern.replace('op:update/id:1', 'op:merge/id:*')]: 'allow' }) }, async (host, evidence) => {
  host.cli(['remember', '--universal', '--force', '--', 'For local fixture, retries are 2.']);
  const before = content(host);
  const parent = await host.parent();
  const text = 'For local fixture, route is now /v2; unique timeout remains 7; retries remain 2.';
  mutationTask(host, { action: 'merge', text, records: [{ id: 1, quote: 'route is /v1' }, { id: 2, quote: 'retries are 2' }] });
  await host.prompt(parent, text);
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.status, 'committed');
  assert.deepEqual(evidence.result.memory_ids, [1, 2]);
  evidence.separate_readback = host.cli(['organize', 'read'], { keys: [{ id: 1, placement: 'universal' }, { id: 2, placement: 'universal' }] });
  const [survivor, source] = evidence.separate_readback.organization.records;
  assert.equal(survivor.snapshot.content, text);
  assert.equal(survivor.snapshot.created_at, before.created_at);
  assert.equal(survivor.snapshot.provenance, before.provenance);
  assert.equal(source.snapshot, null);
  assert.equal(spawns(host).length, 1);
  evidence.activity = host.cli(['activity', 'list', '--writes', '--operation', evidence.result.operation_id]);
  assert.equal(evidence.activity.events[0].detail.metadata.action, 'maintain_merge');
  const ask = host.control.events.find((event) => event.phase === 'ask' && event.request.permission === 'memocap_maintain');
  assert.equal(ask.request.patterns.length, 2);
  await host.captureDone(parent);
});
scenario('native-delete', { permission: (pattern) => ({ [pattern.replace('op:update', 'op:delete')]: 'allow' }) }, async (host, evidence) => {
  const parent = await host.parent();
  const text = 'The local fixture route and unique timeout 7 are permanently retired; no unique information remains.';
  mutationTask(host, { action: 'delete', text, records: [{ id: 1, quote: 'route is /v1' }] });
  await host.prompt(parent, text);
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.status, 'committed');
  assert.equal(content(host), null);
  assert.equal(spawns(host).length, 1);
  evidence.activity = host.cli(['activity', 'list', '--writes', '--operation', evidence.result.operation_id]);
  assert.equal(evidence.activity.events[0].detail.metadata.action, 'maintain_delete');
  await host.captureDone(parent);
});
for (const name of ['cross-environment-merge', 'unique-information-merge']) {
  scenario(name, { permission: (pattern) => ({ [pattern.replace('op:update/id:1', 'op:merge/id:*')]: 'allow' }) }, async (host, evidence) => {
    host.cli(['remember', '--universal', '--force', '--', name === 'cross-environment-merge' ? 'For another environment, route is /v3.' : 'For local fixture, retries are 2.']);
    const participants = { keys: [{ id: 1, placement: 'universal' }, { id: 2, placement: 'universal' }] };
    if (name === 'cross-environment-merge') {
      evidence.before_records = host.cli(['organize', 'read'], participants).organization.records;
      assert.deepEqual(evidence.before_records.map((record) => record.snapshot?.id), [1, 2]);
    }
    const parent = await host.parent();
    const text = 'Proposed merge loses the other environment or a unique retry condition.';
    mutationTask(host, { action: 'merge', text, support: 'unsupported', records: [{ id: 1, quote: 'route is /v1' },
      { id: 2, quote: name === 'cross-environment-merge' ? 'route is /v3' : 'retries are 2' }] });
    await host.prompt(parent, text);
    evidence.result = await review(host, parent);
    assert.equal(evidence.result.reason, 'unsupported');
    assert.equal(spawns(host).length, 0);
    assert.equal(content(host).organized_at, null);
    await host.captureDone(parent);
    if (name === 'cross-environment-merge') {
      evidence.after_records = host.cli(['organize', 'read'], participants).organization.records;
      assert.deepEqual(evidence.after_records, evidence.before_records);
      assert.equal(evidence.result.write_attempts, 0);
    }
  });
}
scenario('receipt-boundary', {}, async (host, evidence) => {
  const parent = await host.parent();
  const tools = host.control.events;
  host.provider.responses.push({ tool: 'memocap_recall', args: { query: 'route', library: true } },
    { tool: 'memocap_read', args: { id: 1, placement: 'universal', content_hash: '0'.repeat(64) } },
    { tool: 'memocap_read', args: { id: 1, placement: 'universal' } },
    { tool: 'memocap_maintain', get args() {
      const handle = tools.findLast((event) => event.phase === 'tool.result' && event.name === 'memocap_read').result.maintenance_read;
      return { operation: 'use', ...handle, receipt_id: 'forged-handle', statements: ['route is /v1'] };
    } }, { text: 'No adopted record.' }, { text: '{"candidates":[]}' });
  await host.prompt(parent, 'Recall, compare a stale read, obtain a full read, then reject a forged declaration.');
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.status, 'no_candidate');
  assert.equal(evidence.result.model_calls, 0);
  const recall = tools.find((event) => event.phase === 'tool.result' && event.name === 'memocap_recall');
  assert.equal(recall.result.maintenance_read, undefined);
  const reads = tools.filter((event) => event.phase === 'tool.result' && event.name === 'memocap_read');
  assert.equal(reads[0].result.record_changed, true);
  assert.equal(reads[0].result.maintenance_read, undefined);
  assert.ok(reads[1].result.maintenance_read.receipt_id);
  await host.captureDone(parent);
  const foreign = await host.parent();
  host.provider.responses.push({ tool: 'memocap_maintain', args: { operation: 'use', ...reads[1].result.maintenance_read,
    statements: ['route is /v1'] } }, { text: 'Cross-parent use rejected.' }, { text: '{"candidates":[]}' });
  await host.prompt(foreign, 'An opaque full-read receipt from a different parent cannot declare use.');
  assert.equal((await review(host, foreign)).model_calls, 0);
  const declaration = tools.findLast((event) => event.phase === 'tool.result' && event.name === 'memocap_maintain');
  assert.equal(declaration.result.status, 'blocked');
  assert.equal(spawns(host).length, 0);
  await host.captureDone(foreign);
});
