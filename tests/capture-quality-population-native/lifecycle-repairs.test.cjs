const assert = require('node:assert/strict');
const test = require('node:test');
const { lifecycleProbe } = require('./lifecycle-probe.cjs');

for (const outcome of ['clean', 'unknown-delete', 'unknown-write', 'remaining-clean', 'remaining-unknown-delete']) test(`stopped plugin close uses owned SDK cleanup: ${outcome}`, async (t) => {
  const unknownDelete = outcome.endsWith('unknown-delete');
  const { createOpencodeClient } = await import('@opencode-ai/sdk');
  const { install } = require('./plugin-runtime.cjs'); const { createFixture } = require('./fixture.cjs');
  const { control, wire } = require('./control.cjs'); const { sources } = require('./authorization.cjs');
  const { selection, endpoint, memoryHTTP, upstream } = require('./selected-provider-fixture.cjs');
  const channel = control('inert'); const remote = upstream({ late: true }); const binding = selection();
  const used = {}; const local = []; let client; let hooks; let pumping; let disposals = 0;
  channel.bind({ charge(key, amount = 1) { used[key] = (used[key] ?? 0) + amount; }, user() {}, record() {} });
  channel.bindProvider({ binding, limits: require('./inventory.cjs').caseLimits('queued-exit-zero'), session: (id) => id === 'root', send: remote.send });
  t.mock.method(globalThis, 'fetch', async (request) => {
    const pathname = new URL(request.url).pathname;
    local.push([request.method, pathname]);
    if (request.method === 'POST' && pathname === '/session') return Response.json({ id: 'child' });
    if (unknownDelete && request.method === 'DELETE') return Response.json(false);
    return Response.json(true);
  });
  const sdk = createOpencodeClient({ baseUrl: 'http://inert.invalid', fetch: (request) => globalThis.fetch(request) });
  try {
    hooks = await install({ client: sdk, serverUrl: new URL('http://inert.invalid') }, {
      kind: 'quality-full-population-plugin-v1', source_sha256: sources().digest, approval_id: 'offline-selection-only',
      privateRoot: '/inert', paths: { database: '/inert/db' }, socket: '/inert/socket', token: 'inert',
      case: 'queued-exit-zero', endpoints: [endpoint], network_binding: binding,
    }, { rpc: wire('/inert/socket', 'inert', memoryHTTP(channel.handler)), providerSend: memoryHTTP(channel.handler),
      native: { initialize: async () => `repository:${'c'.repeat(64)}`, invoke() { assert.fail('native_effect'); }, uncertain: () => outcome === 'unknown-write' },
      fixture: (input, seam) => createFixture(input, { ...seam, factory: async (input) => {
        client = input.client;
        return { async dispose() {
          disposals++;
          for (const id of outcome.startsWith('remaining-') ? [] : hooks.state().children) {
            await client.session.abort({ path: { id } }); await client.session.delete({ path: { id } });
          }
        } };
      } }) });
    const config = { provider: { 'openai-b1': { options: {} } } }; await hooks.config(config);
    pumping = hooks.qualityPump(); await channel.ready;
    await channel.call('bind', { review: true, user: 'fixture', operations: [] });
    await hooks['chat.message']({ sessionID: 'root' }, { message: { id: 'user', sessionID: 'root' }, parts: [] });
    await client.session.create({ body: { parentID: 'root', title: 'memocap capture extract' } });
    const controller = new AbortController();
    const pending = config.provider['openai-b1'].options.fetch(endpoint, { method: 'POST', body: '{}',
      headers: { 'x-memocap-population-session': 'root' }, signal: controller.signal });
    await remote.started; controller.abort(); await assert.rejects(pending, /provider_aborted/);
    await assert.rejects(channel.call('close', { session: 'foreign' }), /cleanup_session_unowned/);
    assert.deepEqual(local, [['POST', '/session']]);
    const closed = channel.call('close', { session: 'root' });
    if (unknownDelete) await assert.rejects(closed, /child_delete_unknown/);
    else assert.deepEqual(await closed, { children: 0, recovery_required: outcome === 'unknown-write' });
    assert.deepEqual(local, [['POST', '/session'], ['POST', '/session/child/abort'], ['DELETE', '/session/child'],
      ...(unknownDelete ? [] : [['POST', '/session/root/abort'], ['DELETE', '/session/root']])]);
    if (outcome !== 'remaining-clean') assert.deepEqual(hooks.state().children, unknownDelete ? ['child'] : []);
    if (unknownDelete) {
      const before = used.total_bytes; const actions = structuredClone(local);
      await hooks.dispose();
      await assert.rejects(channel.call('close', { session: 'root' }), /child_delete_unknown/);
      assert.deepEqual(local, actions); assert.equal(used.total_bytes, before);
      assert.deepEqual(hooks.state().children, ['child']);
    }
    assert.equal(disposals, 1);
    assert.equal(used.sdk_requests, unknownDelete ? 3 : 5);
    const before = used.provider_requests;
    await assert.rejects(config.provider['openai-b1'].options.fetch(endpoint, { method: 'POST', body: '{}',
      headers: { 'x-memocap-population-session': 'root' } }), /provider_aborted/);
    assert.equal(used.provider_requests, before); assert.equal(remote.calls.length, 1);
  } finally {
    channel.stop();
    const [settled] = await Promise.allSettled([pumping]);
    if (settled.status === 'rejected') assert.equal(settled.reason.code, 'control_closed');
  }
});

test('concrete close independently reaches process, control, listener and recovery retention when plugin hangs', async () => {
  const probe = lifecycleProbe({ pluginHangs: true }); await probe.open();
  const closed = await probe.settle(probe.host.close({}));
  assert.equal(closed.done, true);
  for (const phase of ['process.close', 'control.stop', 'listener.close', 'owned.close']) assert.ok(probe.events.includes(phase), phase);
  assert.equal(closed.result.removed, false); assert.equal(closed.result.exited, true);
  assert.equal(closed.result.error, 'plugin_close_timeout');
  assert.ok(closed.elapsed < 3000); assert.equal(closed.remainingTimers, 0);
});

for (const options of [{ pluginError: new Error('first'), processError: new Error('second') },
  { processHangs: true }, { listenerHangs: true }, { controlError: new Error('stop_failed') }, { listenerError: new Error('close_failed') }]) {
  test(`cleanup retains unknown outcomes and still attempts later phases: ${Object.keys(options)[0]}`, async () => {
    const probe = lifecycleProbe(options); await probe.open();
    const closed = await probe.settle(probe.host.close({}));
    assert.equal(closed.done, true); assert.equal(closed.result.removed, false);
    assert.ok(probe.events.includes('listener.close')); assert.ok(probe.events.includes('owned.close'));
    assert.ok(closed.elapsed < 3000); assert.equal(closed.remainingTimers, 0);
    if (options.pluginError) assert.equal(closed.result.error, 'plugin_close_failed');
    if (options.processHangs) assert.equal(closed.result.exited, false);
    if (options.listenerHangs || options.listenerError) assert.equal(closed.result.listener_closed, false);
  });
}

test('all cleanup phase deadlines combined fit inside the existing outer cleanup allowance', async () => {
  const probe = lifecycleProbe({ pluginHangs: true, processHangs: true, controlHangs: true, listenerHangs: true });
  await probe.open();
  const closed = await probe.settle(probe.host.close({}));
  assert.equal(closed.done, true); assert.equal(closed.result.removed, false);
  assert.equal(closed.result.exited, false); assert.equal(closed.result.children, null);
  assert.equal(closed.result.control_stopped, false); assert.equal(closed.result.listener_closed, false);
  assert.deepEqual(Array.from(closed.result.cleanup_errors), ['plugin_close_timeout', 'process_close_timeout', 'control_stop_timeout', 'listener_close_timeout']);
  assert.ok(closed.elapsed < 3000); assert.equal(closed.remainingTimers, 0);
});

for (const options of [{ unknownWrite: true }, { exited: false }, { retain: true }]) {
  test(`concrete cleanup preserves recovery state: ${Object.keys(options)[0]}`, async () => {
    const probe = lifecycleProbe(options); await probe.open();
    const closed = await probe.settle(probe.host.close({ retain_recovery: options.retain }));
    assert.equal(closed.done, true); assert.equal(closed.result.removed, false);
  });
}

test('known clean concrete shutdown removes only owned state after observed exit', async () => {
  const probe = lifecycleProbe(); await probe.open();
  const closed = await probe.settle(probe.host.close({}));
  assert.equal(closed.done, true); assert.equal(closed.result.removed, true);
  assert.equal(closed.result.exited, true); assert.equal(closed.result.children, 0);
  assert.equal(closed.result.listener_closed, true); assert.equal(closed.remainingTimers, 0);
});

for (const present of lifecycleProbe().managedPaths) {
  test(`audited managed presence refuses before listener or launch: ${present}`, async () => {
    const probe = lifecycleProbe({ present, launchTrap: true });
    await assert.rejects(probe.open(), /preload_managed_source_present/);
    assert.equal(probe.events.includes('listener.create'), false); assert.equal(probe.events.includes('launch'), false);
    assert.ok(probe.probes.includes(present)); await probe.host.close({ retain_recovery: true });
  });
}

test('managed sources are rechecked immediately before actual launch', async () => {
  const probe = lifecycleProbe({ appearAtSpawn: true, launchTrap: true });
  await assert.rejects(probe.open(), /preload_managed_source_present/);
  assert.ok(probe.events.includes('listener.listen')); assert.equal(probe.events.includes('launch'), false);
  await probe.host.close({ retain_recovery: true });
});

test('absent managed sources and valid private preparation reach only the inert launch trap', async () => {
  const probe = lifecycleProbe({ launchTrap: true });
  await assert.rejects(probe.open(), /inert_launch_trap/);
  assert.ok(probe.managedPaths.every((file) => probe.probes.includes(file)));
  await probe.host.close({ retain_recovery: true });
});

for (const option of ['malformed', 'stale']) {
  test(`invalid private preparation still refuses startup: ${option}`, async () => {
    const probe = lifecycleProbe({ [option]: true, launchTrap: true });
    await assert.rejects(probe.open(), /preload_preparation_required|preload_discovery_changed/);
    assert.equal(probe.events.includes('listener.create'), false); assert.equal(probe.events.includes('launch'), false);
    await probe.host.close({ retain_recovery: true });
  });
}

test('hung plugin cleanup still proves absence of the inert host and descendant process group', async () => {
  const { launch } = require('./process.cjs');
  const { cleanupOwned } = require('./cleanup.cjs');
  let pgid;
  const child = launch({ sandbox: { path: '/inert/sandbox', policy: { path: '/inert/policy' } }, host: { path: '/inert/host' },
    server: 'http://127.0.0.1:4444', project: require('node:os').tmpdir(), environment: {} }, {
    spawn(_file, _args, options) {
      const leader = require('node:child_process').spawn(process.execPath, ['-e', `
        process.on('SIGTERM', () => {});
        const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
        descendant.once('spawn', () => process.stdout.write('opencode server listening on http://127.0.0.1:4444'));
        descendant.once('close', () => process.exit());
      `], options);
      pgid = leader.pid;
      return leader;
    },
  });
  await child.ready;
  const attempts = [];
  try {
    const closed = await cleanupOwned({ adapter: { close: () => new Promise(() => {}) }, process: child,
      channel: { stop() { attempts.push('control'); } }, listener: { close(done) { attempts.push('listener'); done(); } },
      private: { close(request) { attempts.push('owned'); return { removed: !request.retain_recovery }; } } }, {});
    assert.equal(closed.exited, true); assert.equal(closed.children, 0); assert.equal(closed.removed, false);
    assert.deepEqual(closed.process_evidence, { leader_closed: true, pgid, group_probe: 'ESRCH' });
    assert.deepEqual(attempts, ['control', 'listener', 'owned']); assert.equal(closed.error, 'plugin_close_timeout');
  } finally { await child.close(); }
});
