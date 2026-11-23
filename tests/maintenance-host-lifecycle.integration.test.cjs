const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { maintenanceHost, userPacket } = require('./maintenance-integration/host.cjs');
const { usedTask, revised, spawns, content } = require('./maintenance-integration/scenarios.cjs');
const version = process.env.MEMOCAP_MAINTENANCE_VERSION ?? '1.19.5';
const evidenceDir = process.env.MEMOCAP_MAINTENANCE_EVIDENCE_DIR ?? path.resolve(__dirname, '../.omo/evidence/capture-expansion');
function scenario(name, options, run) {
  test(name, { skip: process.env.MEMOCAP_MAINTENANCE_HOST !== '1', timeout: 90000 }, async (context) => {
    const evidence = { version, name, cleanup: {}, commands: [] };
    let host;
    context.after(async () => {
      if (host) { evidence.events = host.control.events; evidence.requests = host.provider.requests; await host.close(); }
      fs.writeFileSync(path.join(evidenceDir, `repair-${name}-${version}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
      assert.ok(Object.values(evidence.cleanup).every((value) => value === true));
    });
    host = await maintenanceHost(version, evidence, options);
    await run(host, evidence);
  });
}
const cite = (source) => ({ source_id: source.source_id, quote: source.text });
async function adoptedFirst(host, parent) {
  const { provider, control } = host;
  provider.responses.push({ tool: 'memocap_read', args: { id: 1, placement: 'universal' } },
    { tool: 'memocap_maintain', get args() { return { operation: 'use',
      ...control.events.findLast((event) => event.phase === 'tool.result' && event.name === 'memocap_read').result.maintenance_read,
      statements: ['route is /v1'] }; } }, { text: 'Observed alpha route; verification pending.' },
    { text: '{"decision":null}' }, { text: '{"candidates":[]}' });
  await host.prompt(parent, 'Check the local alpha route using the adopted record; keep its unique timeout 7.');
  await control.wait((event) => event.phase === 'maintenance.review' && event.parentID === parent.id);
  await host.captureDone(parent);
}
for (const relation of ['same_task', 'unknown', 'new_task', 'environment_changed']) {
  scenario(`multiturn-${relation}`, {}, async (host, evidence) => {
    const parent = await host.parent();
    await adoptedFirst(host, parent);
    const participants = { keys: [{ id: 1, placement: 'universal' }] };
    if (relation === 'environment_changed') {
      evidence.before_records = host.cli(['organize', 'read'], participants).organization.records;
      assert.equal(evidence.before_records[0].snapshot.id, 1);
    }
    host.provider.responses.push({ text: 'Independent verification finished.' }, { get text() {
      const packet = userPacket(host.provider);
      assert.equal(packet.stage, 'extract');
      assert.ok(packet.prior);
      return JSON.stringify({ decision: { action: 'update', target: packet.used[0].use_id, content: revised,
        citations: packet.evidence.map(cite) }, continuity: relation === 'same_task' ? {
        status: relation, goal: 'check route', object: 'local route', environment: 'alpha', citations: packet.evidence.map(cite),
      } : { status: 'unknown' } });
    } }, ...(relation === 'same_task' ? [{ get text() { const packet = userPacket(host.provider);
      return JSON.stringify({ ...packet.binding, status: 'supported', continuity: 'supported' }); } },
    { tool: 'memocap_maintain', get args() { return { operation: 'apply', proposal_id: userPacket(host.provider).proposal_id }; } }] : []),
    { text: '{"candidates":[]}' });
    await host.prompt(parent, relation === 'environment_changed' ? 'Switch to beta and check another environment.' :
      relation === 'new_task' ? 'New task: check a different object.' : `Continue the same local alpha route check. ${revised}`);
    evidence.result = await host.control.wait((event) => event.phase === 'maintenance.review' && event.parentID === parent.id && event.user_id !==
      host.control.events.find((entry) => entry.phase === 'maintenance.review' && entry.parentID === parent.id).user_id);
    assert.equal(evidence.result.status, relation === 'same_task' ? 'committed' : 'blocked');
    assert.equal(spawns(host).length, relation === 'same_task' ? 1 : 0);
    assert.equal(host.control.events.filter((event) => event.phase === 'tool.result' && event.name === 'memocap_read').length, 1);
    assert.equal(host.control.events.filter((event) => event.phase === 'session.messages' && event.id === parent.id).length, 0);
    if (relation === 'same_task') {
      assert.equal(evidence.result.model_calls, 3);
      assert.equal(content(host).content, revised);
      assert.equal(host.cli(['activity', 'list', '--writes', '--operation', evidence.result.operation_id]).events[0].detail.metadata.action, 'maintain_update');
      assert.ok(host.control.events.some((event) => event.phase === 'generation.blocked' && event.code === 'model_budget'));
    }
    if (relation === 'environment_changed') {
      evidence.after_records = host.cli(['organize', 'read'], participants).organization.records;
      assert.deepEqual(evidence.after_records, evidence.before_records);
      assert.equal(evidence.result.write_attempts, 0);
    }
  });
}
for (const surface of ['system', 'messages']) scenario(`inherited-secret-${surface}`, { childSecret: surface }, async (host, evidence) => {
  const parent = await host.parent();
  usedTask(host);
  await host.prompt(parent, revised);
  evidence.result = await host.control.wait((event) => event.phase === 'maintenance.review' && event.parentID === parent.id);
  assert.equal(evidence.result.reason, 'sensitive_input');
  assert.equal(host.provider.requests.length, 3);
  assert.equal(spawns(host).length, 0);
  assert.equal(JSON.stringify(host.provider.requests).includes('fixture-only'), false);
});

scenario('replacement-after-failed-access', {}, async (host, evidence) => {
  const parent = await host.parent();
  const filePath = path.join(host.root, 'project/current-authority.txt');
  fs.writeFileSync(filePath, revised);
  const { provider, control } = host;
  provider.responses.push({ tool: 'memocap_read', args: { id: 1, placement: 'universal' } },
    { tool: 'memocap_maintain', get args() { return { operation: 'use',
      ...control.events.findLast((event) => event.phase === 'tool.result' && event.name === 'memocap_read').result.maintenance_read,
      statements: ['route is /v1'] }; } },
    { tool: 'read', args: { filePath: path.join(host.root, 'project/old-missing.txt') } },
    { tool: 'read', args: { filePath } }, { text: 'Replacement independently read; original remains unavailable.' },
    { get text() { const packet = userPacket(provider);
      assert.ok(packet.evidence.some((entry) => entry.outcome === 'missing'));
      return JSON.stringify({ decision: { action: 'update', target: packet.used[0].use_id, content: revised,
        citations: [cite(packet.evidence.find((entry) => entry.text === revised))] } }); } },
    { get text() { const packet = userPacket(provider);
      assert.ok(packet.evidence.some((entry) => entry.outcome === 'missing'));
      return JSON.stringify({ ...packet.binding, status: 'supported' }); } },
    { tool: 'memocap_maintain', get args() { return { operation: 'apply', proposal_id: userPacket(provider).proposal_id }; } },
    { text: '{"candidates":[]}' });
  await host.prompt(parent, 'Read the unavailable old source, then the independently authorized complete replacement authority for this local route.');
  evidence.result = await control.wait((event) => event.phase === 'maintenance.review' && event.parentID === parent.id);
  assert.equal(evidence.result.status, 'committed');
  assert.equal(content(host).content, revised);
  assert.equal(spawns(host).length, 1);
});

scenario('multiturn-current-only', { permission: (pattern) => ({ [pattern.replace(/:1$/, ':2')]: 'allow' }) }, async (host, evidence) => {
  host.cli(['remember', '--universal', '--force', '--', 'For beta fixture, route is /v1 and unique timeout is 9.']);
  const parent = await host.parent();
  await adoptedFirst(host, parent);
  const beta = 'For beta fixture, route is now /v2; unique timeout remains 9.';
  const { provider, control } = host;
  provider.responses.push({ tool: 'memocap_read', args: { id: 2, placement: 'universal' } },
    { tool: 'memocap_maintain', get args() { return { operation: 'use',
      ...control.events.findLast((event) => event.phase === 'tool.result' && event.name === 'memocap_read').result.maintenance_read,
      statements: ['route is /v1'] }; } }, { text: 'Current beta record adopted.' },
    { get text() { const packet = userPacket(provider);
      assert.ok(packet.prior);
      return JSON.stringify({ decision: { action: 'update', target: packet.used.find((entry) => entry.snapshot.id === 2).use_id,
        content: beta, citations: packet.evidence.filter((entry) => entry.task.taskID === packet.prior.current_task.taskID).map(cite) },
        continuity: { status: 'unknown' } }); } },
    { get text() { const packet = userPacket(provider);
      assert.deepEqual(packet.used.map((entry) => entry.snapshot.id), [2]);
      assert.equal(packet.evidence.length, 1);
      assert.equal(packet.continuity, undefined);
      return JSON.stringify({ ...packet.binding, status: 'supported' }); } },
    { tool: 'memocap_maintain', get args() { return { operation: 'apply', proposal_id: userPacket(provider).proposal_id }; } },
    { text: '{"candidates":[]}' });
  await host.prompt(parent, `New task, beta environment. Independently update only the newly adopted beta record. ${beta}`);
  const earlier = control.events.find((event) => event.phase === 'maintenance.review' && event.parentID === parent.id);
  evidence.result = await control.wait((event) => event.phase === 'maintenance.review' && event.parentID === parent.id && event.user_id !== earlier.user_id);
  assert.equal(evidence.result.status, 'committed');
  assert.equal(evidence.result.model_calls, 3);
  assert.equal(spawns(host).length, 1);
  assert.equal(content(host).content, 'For local fixture, route is /v1 and unique timeout is 7.');
  assert.equal(host.cli(['organize', 'read'], { keys: [{ id: 2, placement: 'universal' }] }).organization.records[0].snapshot.content, beta);
});

scenario('multiturn-origin-switch', {}, async (host, evidence) => {
  const parent = await host.parent();
  await adoptedFirst(host, parent);
  const directory = path.join(host.root, 'other-project');
  fs.mkdirSync(directory);
  host.provider.responses.push({ tool: 'memocap_scope', args: { paths: [directory] } },
    { text: 'Switched repository context.' }, { text: '{"candidates":[]}' });
  await host.prompt(parent, 'Switch to the other local repository context for a new task.');
  const earlier = host.control.events.find((event) => event.phase === 'maintenance.review' && event.parentID === parent.id);
  evidence.result = await host.control.wait((event) => event.phase === 'maintenance.review' && event.parentID === parent.id && event.user_id !== earlier.user_id);
  assert.equal(evidence.result.reason, 'no_adopted_records');
  assert.equal(evidence.result.model_calls, 0);
  assert.equal(spawns(host).length, 0);
  assert.equal(content(host).content, 'For local fixture, route is /v1 and unique timeout is 7.');
  const scoped = host.control.events.find((event) => event.phase === 'tool.result' && event.name === 'memocap_scope');
  assert.ok(scoped);
  assert.notEqual(scoped.result.status, 'blocked');
});
