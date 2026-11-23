const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { maintenanceHost } = require('./maintenance-integration/host.cjs');
const { usedTask, revised, review, spawns, content } = require('./maintenance-integration/scenarios.cjs');
const version = process.env.MEMOCAP_MAINTENANCE_VERSION ?? '1.19.5';
const enabled = process.env.MEMOCAP_MAINTENANCE_HOST === '1';
function scenario(name, options, run) {
  test(name, { skip: !enabled, timeout: 90000 }, async (context) => {
    const evidence = { name, version, cleanup: {}, commands: [] };
    const filename = path.resolve(__dirname, `../.omo/evidence/capture-expansion/post-use-${name}-${version}-${randomUUID()}.json`);
    assert.ok(fs.statSync(path.dirname(filename)).isDirectory());
    let host;
    context.after(async () => {
      try {
        if (host) {
          evidence.events = host.control.events;
          evidence.requests = host.provider.requests;
          await host.close();
        }
      } catch (error) {
        evidence.cleanup.error = error instanceof Error ? error.stack : String(error);
        throw error;
      } finally {
        fs.writeFileSync(filename, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
        context.diagnostic(`evidence: ${filename}`);
      }
    });
    try {
      host = await maintenanceHost(version, evidence, options);
      evidence.sandbox = { root: host.root, database: host.database, home: host.env.HOME,
        config: host.env.XDG_CONFIG_HOME, cache: host.env.XDG_CACHE_HOME,
        data: host.env.XDG_DATA_HOME, state: host.env.XDG_STATE_HOME,
        provider: host.provider.url, control: host.control.url };
      await run(host, evidence);
      evidence.assertions = 'passed';
    } catch (error) {
      evidence.failure = error instanceof Error ? error.stack : String(error);
      throw error;
    }
  });
}
scenario('missing-grant', { permission: () => 'allow' }, async (host, evidence) => {
  const parent = await host.parent();
  usedTask(host, { commit: false });
  await host.prompt(parent, revised);
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.status, 'proposal');
  assert.equal(evidence.result.reason, 'maintenance_grant_required');
  assert.equal(evidence.result.proposal.content, revised);
  assert.deepEqual(evidence.result.proposal.required_patterns, [host.pattern]);
  assert.equal(evidence.result.model_calls, 2);
  assert.equal(spawns(host).length, 0);
  assert.equal(content(host).organized_at, null);
});
scenario('scoped-deny', { permission: (pattern) => ({ [pattern.replace(/:1$/, ':*')]: 'allow', [pattern]: 'deny' }) }, async (host, evidence) => {
  const parent = await host.parent();
  usedTask(host, { commit: false });
  await host.prompt(parent, revised);
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.reason, 'permission_deny');
  assert.equal(spawns(host).length, 0);
  assert.equal(host.control.events.filter((event) => event.phase === 'ask' && event.request.permission === 'memocap_maintain').length, 0);
});
scenario('id-star-grant', { permission: (pattern) => ({ [pattern.replace(/:1$/, ':*')]: 'allow' }) }, async (host, evidence) => {
  const parent = await host.parent();
  usedTask(host);
  await host.prompt(parent, revised);
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.status, 'committed');
  assert.equal(spawns(host).length, 1);
  assert.equal(content(host).content, revised);
  await host.captureDone(parent);
});
scenario('native-ask-reject', {}, async (host, evidence) => {
  const parent = await host.parent('ask');
  usedTask(host);
  await host.prompt(parent, revised);
  const asked = await host.control.wait((event) => event.phase === 'permission.asked' && event.event.properties.permission === 'memocap_maintain');
  const request = asked.event.properties;
  host.unwrap(await host.client.postSessionIdPermissionsPermissionId({ path: { id: request.sessionID, permissionID: request.id }, body: { response: 'reject' } }));
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.status, 'denied');
  assert.equal(evidence.result.reason, 'native_permission_denied');
  assert.equal(spawns(host).length, 0);
  assert.equal(content(host).organized_at, null);
});
scenario('native-cas-conflict', { nativeMode: 'before' }, async (host, evidence) => {
  evidence.before = content(host);
  const parent = await host.parent();
  usedTask(host);
  await host.prompt(parent, revised);
  await host.control.wait((event) => event.phase === 'gate.waiting' && event.sessionID === 'native-before');
  host.sql("UPDATE memories SET tags='concurrent-change' WHERE id=1;");
  evidence.concurrent = content(host);
  host.control.release('native-before');
  evidence.result = await review(host, parent);
  evidence.after = content(host);
  evidence.activity = host.cli(['activity', 'list', '--writes']);
  assert.deepEqual(evidence.after, evidence.concurrent);
  assert.notDeepEqual(evidence.concurrent, evidence.before);
  assert.equal(evidence.activity.events.filter((event) => event.detail.metadata.action.startsWith('maintain_')).length, 0);
  assert.equal(evidence.result.status, 'conflict');
  assert.equal(evidence.result.reason, 'rolled_back');
  assert.equal(spawns(host).length, 1);
  assert.equal(content(host).tags, 'concurrent-change');
  assert.equal(content(host).organized_at, null);
});
scenario('native-rollback', {}, async (host, evidence) => {
  const before = content(host);
  evidence.before = before;
  host.sql("CREATE TRIGGER maintenance_fixture_rollback BEFORE UPDATE OF content ON memories BEGIN SELECT RAISE(ABORT, 'maintenance_fixture_rollback'); END;");
  const parent = await host.parent();
  usedTask(host);
  await host.prompt(parent, revised);
  evidence.result = await review(host, parent);
  evidence.after = content(host);
  evidence.activity = host.cli(['activity', 'list', '--writes']);
  assert.deepEqual(evidence.after, evidence.before);
  assert.equal(evidence.activity.events.filter((event) => event.detail.metadata.action.startsWith('maintain_')).length, 0);
  assert.equal(evidence.result.status, 'conflict');
  assert.equal(evidence.result.reason, 'rolled_back');
  assert.equal(spawns(host).length, 1);
  assert.deepEqual(content(host), before);
  assert.equal(host.cli(['activity', 'list', '--writes']).events.filter((event) => event.detail.metadata.action.startsWith('maintain_')).length, 0);
});
scenario('response-lost', { nativeMode: 'lost' }, async (host, evidence) => {
  evidence.before = content(host);
  const parent = await host.parent();
  usedTask(host);
  await host.prompt(parent, revised);
  evidence.result = await review(host, parent);
  evidence.after = content(host);
  evidence.worker_result = host.control.events.findLast((event) => event.phase === 'tool.result' && event.name === 'memocap_maintain');
  evidence.activity = host.cli(['activity', 'list', '--writes']);
  assert.equal(evidence.after.content, revised);
  assert.notEqual(evidence.after.organized_at, null);
  assert.equal(evidence.activity.events.filter((event) => event.detail.metadata.action === 'maintain_update').length, 1);
  assert.equal(evidence.result.status, 'unknown');
  assert.equal(evidence.worker_result.result.status, 'unknown');
  assert.equal(host.control.events.findLast((event) => event.phase === 'tool.result' && event.name === 'memocap_maintain').result.no_replay, true);
  assert.equal(spawns(host).length, 1);
  assert.equal(content(host).content, revised);
  await host.captureDone(parent);
  const proposal = host.control.events.find((event) => event.phase === 'ask' && event.request.permission === 'memocap_maintain').request.metadata.proposal_id;
  evidence.replay_boundary = { event_cursor: host.control.events.length, request_cursor: host.provider.requests.length,
    pending_responses: structuredClone(host.provider.responses), proposal_id: proposal };
  assert.deepEqual(evidence.replay_boundary.pending_responses, [{ text: '{"candidates":[]}' }]);
  host.provider.responses.shift();
  host.provider.responses.push({ tool: 'memocap_maintain', args: { operation: 'apply', proposal_id: proposal } }, { text: 'Replay rejected.' });
  const reply = await host.prompt(parent, 'Try the same proposal again.');
  evidence.replay_reply = reply;
  const fresh = host.control.events.slice(evidence.replay_boundary.event_cursor);
  const replay = fresh.find((event) => event.phase === 'tool.result' && event.name === 'memocap_maintain' &&
    event.sessionID === parent.id && event.args.operation === 'apply' && event.args.proposal_id === proposal);
  evidence.replay = replay;
  evidence.after_replay = content(host);
  evidence.activity_after_replay = host.cli(['activity', 'list', '--writes']);
  assert.deepEqual(evidence.after_replay, evidence.after);
  assert.deepEqual(evidence.activity_after_replay.events.filter((event) => event.detail.metadata.action.startsWith('maintain_')),
    evidence.activity.events.filter((event) => event.detail.metadata.action.startsWith('maintain_')));
  assert.ok(replay, 'fresh exact parent apply must return a tool result');
  assert.notEqual(replay.messageID, host.control.events.find((event) => event.phase === 'tool.result' &&
    event.name === 'memocap_maintain' && event.sessionID === parent.id).messageID);
  const messages = host.unwrap(await host.client.session.messages({ path: { id: parent.id } }));
  const message = messages.find((entry) => entry.info.id === replay.messageID);
  assert.equal(message.info.parentID, reply.info.parentID);
  assert.notEqual(message.info.parentID, evidence.result.user_id);
  const part = message.parts.find((entry) => entry.type === 'tool' && entry.tool === 'memocap_maintain');
  assert.deepEqual(part.state.input, { operation: 'apply', proposal_id: proposal });
  assert.equal(part.callID, `call_${evidence.replay_boundary.request_cursor + 1}`);
  assert.equal(part.state.status, 'completed');
  assert.deepEqual(JSON.parse(part.state.output), replay.result);
  assert.ok(fresh.some((event) => event.phase === 'native.tool' && event.part.messageID === replay.messageID &&
    event.part.callID === part.callID && event.part.state.status === 'completed'));
  evidence.replay_correlation = { parent_id: parent.id, user_message_id: message.info.parentID,
    assistant_message_id: replay.messageID, call_id: part.callID, native_part: part };
  const receiptRequest = host.provider.requests[evidence.replay_boundary.request_cursor + 1];
  const receipt = receiptRequest.body.messages.find((entry) => entry.role === 'tool' && entry.tool_call_id === part.callID);
  assert.deepEqual(JSON.parse(receipt.content), replay.result);
  evidence.replay_correlation.receipt_request_index = evidence.replay_boundary.request_cursor + 1;
  assert.equal(replay.result.status, 'blocked');
  assert.equal(replay.result.no_replay, true);
  assert.equal(host.provider.errors.length, 0);
  assert.equal(spawns(host).length, 1);
});
scenario('postdispatch-abort', { nativeMode: 'after' }, async (host, evidence) => {
  const parent = await host.parent();
  usedTask(host);
  await host.prompt(parent, revised);
  await host.control.wait((event) => event.phase === 'native.completed');
  const asked = host.control.events.find((event) => event.phase === 'ask' && event.request.permission === 'memocap_maintain');
  host.unwrap(await host.client.session.abort({ path: { id: asked.sessionID } }));
  host.control.release('native-after');
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.status, 'committed');
  assert.equal(evidence.result.write_attempts, 1);
  assert.equal(content(host).content, revised);
  assert.equal(spawns(host).length, 1);
});
scenario('prewrite-new-input', {}, async (host, evidence) => {
  const parent = await host.parent();
  usedTask(host);
  await host.prompt(parent, revised);
  await host.control.wait((event) => event.phase === 'ask' && event.request.permission === 'memocap_maintain');
  host.control.settings.handshakeGate = true;
  await host.control.wait((event) => event.phase === 'gate.waiting' && event.sessionID === 'handshake');
  host.provider.responses.push({ text: 'Next task completed.' });
  const next = host.prompt(parent, 'New task invalidates the earlier maintenance task.');
  host.control.settings.handshakeGate = false;
  host.control.releaseAll();
  await next;
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.reason, 'new_input');
  assert.equal(evidence.result.write_attempts, 0);
  assert.equal(spawns(host).length, 0);
  assert.equal(content(host).organized_at, null);
});
scenario('activity-failure', {}, async (host, evidence) => {
  host.sql("CREATE TRIGGER maintenance_fixture_activity_failure BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END;");
  const parent = await host.parent();
  usedTask(host);
  await host.prompt(parent, revised);
  evidence.result = await review(host, parent);
  assert.equal(evidence.result.status, 'committed');
  assert.equal(evidence.result.warning, 'maintenance_activity_failed');
  assert.equal(content(host).content, revised);
  assert.equal(spawns(host).length, 1);
  assert.equal(host.cli(['activity', 'list', '--writes']).events.length, 1);
});
