const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function fixture() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 123;
  const calls = { kills: 0, closes: 0, stops: 0, listeners: 0, owned: [] };
  const dependencies = { spawn(_file, _args, options) { calls.stdio = options.stdio; return child; },
    kill(_pgid, signal) {
      if (signal === 0) throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
      calls.kills++; child.emit('close', null, 'SIGTERM');
    } };
  const { launch } = require('./process.cjs');
  const processState = launch({ server: 'http://127.0.0.1:49173', project: '/synthetic/project',
    environment: {}, sandbox: { path: '/synthetic/sandbox', policy: { path: '/synthetic/policy' } },
    host: { path: '/synthetic/host' } }, dependencies);
  const outcome = processState.ready.then(() => null, (error) => error);
  return { child, calls, processState, outcome };
}
const blank = { exit_observed: true, exit_code: null, exit_signal: null, readiness: 'not_seen',
  stdout_bytes_capped: 0, stderr_bytes_capped: 0, stderr_truncated: false, stderr_categories: [] };

for (const [code, signal, expectedSignal] of [[65, null, null], [null, 'SIGTERM', 'SIGTERM'],
  [null, 'SIGKILL', 'SIGKILL'], [null, 'private-signal-text', 'other'], [undefined, undefined, null]]) {
  test(`preserves bounded exit metadata when close reports ${code ?? 'unknown'}/${expectedSignal}`, async () => {
    const item = fixture();
    item.child.emit('close', code, signal);
    const error = await item.outcome;
    assert.equal(error.code, 'host_exited_before_ready');
    assert.deepEqual(error.startup_diagnostics, { ...blank, exit_code: code ?? null, exit_signal: expectedSignal });
    assert.equal(await item.processState.close(), true);
    assert.equal(item.calls.kills, 0);
  });
}

test('pipes stderr and preserves only reported categories across split tokens', async () => {
  const item = fixture();
  for (const chunk of ['sandbox-', 'exec: EAC', 'CES EP', 'ERM EADDR', 'INUSE /private/secret auth=secret']) item.child.stderr.write(chunk);
  item.child.emit('close', 65, null);
  const error = await item.outcome;
  assert.deepEqual(item.calls.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(error.startup_diagnostics.stderr_categories, ['sandbox_message', 'permission_message', 'address_in_use_message']);
  assert.equal(JSON.stringify(error.startup_diagnostics).includes('secret'), false);
  assert.equal(Object.isFrozen(error.startup_diagnostics), true);
  assert.equal(Object.isFrozen(error.startup_diagnostics.stderr_categories), true);
});

test('classifies only the first 4096 stderr bytes then drains a secret tail', async () => {
  const item = fixture();
  item.child.stderr.write(`${'x'.repeat(4090)}EACCES`);
  item.child.stderr.write(' EADDRINUSE sandbox-exec: secret'.repeat(1000));
  item.child.emit('close', 65, null);
  const { startup_diagnostics: summary } = await item.outcome;
  assert.deepEqual(summary, { ...blank, exit_code: 65, stderr_bytes_capped: 4097,
    stderr_truncated: true, stderr_categories: ['permission_message'] });
  assert.equal(item.child.stderr.readableLength, 0);
});

test('does not complete a token that crosses the stderr prefix budget', async () => {
  const item = fixture();
  item.child.stderr.write(`${'x'.repeat(4093)}EAC`); item.child.stderr.write('CES');
  item.child.emit('close', 65, null);
  assert.deepEqual((await item.outcome).startup_diagnostics.stderr_categories, []);
});

test('accepts the original exact stdout readiness and confirms normal close once', async () => {
  const item = fixture();
  item.child.stdout.write('opencode server listen'); item.child.stdout.write('ing on http://127.0.0.1:49173\n');
  assert.equal(await item.outcome, null);
  assert.equal(await item.processState.close(), true);
  assert.equal(await item.processState.close(), true);
  assert.equal(item.calls.kills, 1);
});

test('stderr-only readiness does not make stdout ready', async () => {
  const item = fixture();
  item.child.stderr.write('opencode server listening on http://127.0.0.1:49173');
  item.child.emit('close', 65, null);
  const error = await item.outcome;
  assert.equal(error.code, 'host_exited_before_ready');
  assert.equal(error.startup_diagnostics.readiness, 'not_seen');
});

test('accepts a ready marker ending at exactly 4096 stdout bytes', async () => {
  const item = fixture();
  const marker = 'opencode server listening on http://127.0.0.1:49173';
  item.child.stdout.write('x'.repeat(4096 - marker.length)); item.child.stdout.write(marker);
  assert.equal(await item.outcome, null);
  assert.equal(await item.processState.close(), true);
});

test('uses byte budgets for multibyte stderr without leaking its contents', async () => {
  const item = fixture();
  item.child.stderr.write('界'.repeat(1363)); item.child.stderr.write('EPERM');
  item.child.stderr.write('EADDRINUSE'); item.child.emit('close', 65, null);
  assert.deepEqual((await item.outcome).startup_diagnostics, { ...blank, exit_code: 65,
    stderr_bytes_capped: 4097, stderr_truncated: true, stderr_categories: ['permission_message'] });
});

test('freezes the first mismatch before late output error and repeated close', async () => {
  const item = fixture();
  item.child.stdout.write('opencode server listening on http://127.0.0.1:49174');
  const error = await item.outcome;
  const original = JSON.stringify(error.startup_diagnostics);
  item.child.stderr.write('EACCES'); item.child.stdout.write('late');
  item.child.emit('error', new Error('private')); item.child.emit('error', new Error('private'));
  item.child.emit('close', 65, null); item.child.emit('close', 0, null);
  assert.equal(error.code, 'host_endpoint_mismatch');
  assert.equal(error.startup_diagnostics.readiness, 'mismatch');
  assert.equal(error.startup_diagnostics.exit_observed, false);
  assert.equal(error.startup_diagnostics.exit_code, null);
  assert.equal(JSON.stringify(error.startup_diagnostics), original);
  assert.equal(await item.processState.close(), true);
});

test('preserves stdout budget reason and saturated byte count', async () => {
  const item = fixture();
  item.child.stdout.write('x'.repeat(9000));
  const error = await item.outcome;
  item.child.emit('close', 65, null);
  assert.equal(error.code, 'host_start_output_budget');
  assert.deepEqual(error.startup_diagnostics, { ...blank, exit_observed: false, stdout_bytes_capped: 4097 });
});

test('keeps unknown exit on spawn error even after close', async () => {
  const item = fixture();
  item.child.emit('error', new Error('private')); item.child.emit('close', 0, null);
  const error = await item.outcome;
  assert.equal(error.code, 'host_spawn_failed');
  assert.deepEqual(error.startup_diagnostics, { ...blank, exit_observed: false });
});

test('deadline remains terminal without fabricating an exit', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const item = fixture();
  context.mock.timers.tick(30000);
  const error = await item.outcome;
  item.child.emit('close', 65, null);
  assert.equal(error.code, 'host_start_deadline');
  assert.deepEqual(error.startup_diagnostics, { ...blank, exit_observed: false });
});

test('unconfirmed process close stays false at the original deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const item = fixture();
  item.child.stdout.write('opencode server listening on http://127.0.0.1:49173');
  await item.outcome;
  item.child.removeAllListeners('close');
  const closing = item.processState.close();
  context.mock.timers.tick(2000);
  assert.equal(await closing, false);
});

test('actual blocked runCase carries startup summary through retained-root cleanup', async () => {
  const item = fixture();
  const { runCase } = require('./adapter.cjs');
  const { cleanupOwned } = require('./cleanup.cjs');
  const host = { mode: 'offline', async open() {
    item.child.stderr.write('sandbox-exec: EPERM private'); item.child.emit('close', 65, null);
    await item.processState.ready;
  }, async close(request) {
    item.calls.closes++;
    return cleanupOwned({ process: item.processState, adapter: { async close() { return {}; } },
      channel: { stop() { item.calls.stops++; } }, listener: { close(callback) { item.calls.listeners++; callback(); } },
      private: { close(value) { item.calls.owned.push(value); return { removed: !value.retain_recovery, root_retained: value.retain_recovery }; } } }, request);
  } };
  const result = await runCase('read-route', { host, budget: { mode: 'offline', approved: false } });
  assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'host_exited_before_ready');
  assert.deepEqual(result.startup_diagnostics, { ...blank, exit_code: 65, stderr_bytes_capped: 27,
    stderr_categories: ['sandbox_message', 'permission_message'] });
  assert.deepEqual(result.cleanup, { removed: false, root_retained: true, exited: true, children: 0,
    control_stopped: true, listener_closed: true, process_evidence: { leader_closed: true, pgid: 123, group_probe: 'ESRCH' } });
  assert.deepEqual(item.calls.owned, [{ exited: true, retain_recovery: true }]);
  assert.equal(item.calls.closes, 1); assert.equal(item.calls.stops, 1); assert.equal(item.calls.listeners, 1);
  assert.equal(result.turns.length, 0); assert.equal(result.quality_credit, false);
  assert.equal(Object.isFrozen(result.startup_diagnostics), true);
});

test('unrelated errors and inherited diagnostics do not acquire a startup body', async () => {
  const { runCase } = require('./adapter.cjs');
  const { TransportBlocked } = require('./value.cjs');
  const inherited = new TransportBlocked('synthetic_block');
  Object.setPrototypeOf(inherited, Object.assign(Object.create(TransportBlocked.prototype), { startup_diagnostics: blank }));
  for (const error of [new Error('private'), inherited, new TransportBlocked('synthetic_block')]) {
    const host = { mode: 'offline', async open() { throw error; }, async close() { return { exited: true, removed: false, children: 0 }; } };
    const result = await runCase('read-route', { host, budget: { mode: 'offline', approved: false } });
    assert.equal(Object.hasOwn(result, 'startup_diagnostics'), false);
    assert.equal(result.reason, error instanceof TransportBlocked ? 'synthetic_block' : 'host_boundary_failed');
  }
});

test('projects own summaries without raw fields and prevents snapshot mutation', async () => {
  const { runCase } = require('./adapter.cjs');
  const { TransportBlocked } = require('./value.cjs');
  const input = { ...blank, exit_code: 65, stderr_categories: ['permission_message', 'private'], raw: 'private' };
  const error = new TransportBlocked('synthetic_block', input);
  input.exit_code = 0; input.stderr_categories.push('sandbox_message');
  const host = { mode: 'offline', async open() { throw error; }, async close() { return { exited: true, children: 0, removed: false }; } };
  const result = await runCase('read-route', { host, budget: { mode: 'offline', approved: false } });
  assert.deepEqual(result.startup_diagnostics, { ...blank, exit_code: 65, stderr_categories: ['permission_message'] });
  assert.equal(Reflect.set(error, 'startup_diagnostics', input), false);
  assert.equal(Reflect.set(result.startup_diagnostics, 'exit_code', 0), false);
  assert.throws(() => result.startup_diagnostics.stderr_categories.push('sandbox_message'), TypeError);
});
