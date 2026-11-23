const test = require('node:test');
const assert = require('node:assert/strict');
const { SharedBudget } = require('./journal.cjs');
const { nativeFetch, correlation } = require('./provider.cjs');
const { environment, startHost, fixtureURL } = require('./host.cjs');
const { memoryIO, processFake } = require('./fakes.cjs');
const { root } = require('./approval.cjs');
const { invokeNative } = require('./native-proxy.cjs');
const { fakePreload, withAuditedAccount } = require('./preload-decision.test-support.cjs');

function budget() {
  return SharedBudget.consume('/attempt', { batch: 'offline-test' }, { io: memoryIO() });
}

for (const [kind, result, expected] of [
  ['failure', null, 'dispatch_uncertain'], ['redirect', 307, 'unexpected_destination'], ['denial', 403, 'permission_denied'],
]) {
  test(`provider seam charges the actual fake ${kind} before stopping all later calls`, async () => {
    const shared = budget(); shared.host('nonpure'); shared.root('root', 'user');
    let calls = 0;
    const seam = nativeFetch({ budget: shared, providerDestinations: ['https://provider.invalid/api'], authDestinations: [],
      transport: async () => { calls++; if (result === null) throw new Error('SECRET'); return new Response('', { status: result }); } });
    await assert.rejects(() => seam.provider('https://provider.invalid/api', { headers: { [correlation]: 'root' } }), { code: expected });
    await assert.rejects(() => seam.provider('https://provider.invalid/api'), { code: expected });
    assert.equal(shared.snapshot().dispatches, 1);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(shared.snapshot()).includes('SECRET'), false);
  });
}

test('auth and background calls consume natural quota while control HTTP consumes no provider allowance', async () => {
  const shared = budget(); shared.host('nonpure');
  const sent = [];
  const seam = nativeFetch({ budget: shared, providerDestinations: ['https://provider.invalid/api'],
    authDestinations: ['https://auth.invalid/refresh'], controlOrigin: 'http://127.0.0.1:8123',
    transport: async (request) => { sent.push(request); return new Response(''); } });
  await seam.global('http://127.0.0.1:8123/config');
  await seam.global('https://auth.invalid/refresh');
  await seam.provider('https://provider.invalid/api');
  assert.equal(shared.snapshot().natural, 2);
  assert.deepEqual(shared.snapshot().events.filter((event) => event.kind === 'provider.dispatch')
    .map((event) => [event.session, event.destination_kind]), [[null, 'auth'], [null, 'provider']]);
  assert.equal(sent.length, 3);
});

test('global provider bypass and unknown destinations are refused before fake transport', async () => {
  for (const [url, expected] of [['https://provider.invalid/api', 'provider_hook_bypassed'],
    ['https://unknown.invalid/path?secret=WITHHELD', 'unexpected_destination']]) {
    const shared = budget(); shared.host('nonpure');
    const seam = nativeFetch({ budget: shared, providerDestinations: ['https://provider.invalid/api'], authDestinations: [],
      transport: async () => assert.fail('transport must not run') });
    await assert.rejects(() => seam.global(url), { code: expected });
    assert.equal(shared.snapshot().dispatches, 0);
    assert.equal(JSON.stringify(shared.snapshot()).includes('WITHHELD'), false);
  }
});

const paths = { home: '/owned/home', config: '/owned/config', data: '/owned/data', cache: '/owned/cache',
  state: '/owned/state', tmp: '/owned/tmp', database: '/owned/memory.sqlite', launcher: '/owned/native.cjs',
  control: '/owned/control.json', project: '/owned/project' };
const approval = { batch: 'offline-test', sandbox: { path: '/sandbox' }, policy: { path: '/policy' },
  preflight_policy: { path: '/pure-policy' }, host: { path: '/host' } };

test('native host arguments and literal environment establish isolation before fake preload', async () => {
  const shared = budget();
  const log = [];
  const client = { _client: { get: async () => ({ data: { version: '1.19.5' } }) },
    config: { get: async () => ({ data: { plugin: [fixtureURL], plugin_origins: [{ spec: fixtureURL, scope: 'local', source: 'OPENCODE_CONFIG_CONTENT' }], mcp: {} } }) },
    mcp: { status: async () => ({ data: {} }) } };
  const host = await startHost({ input: { profileRef: '/native-profile' }, approval, paths, pure: false, budget: shared },
    { spawn: processFake(log), preloadCheck: (request) => fakePreload(request).proof,
      clientFactory: () => client, fetch: async () => { log.push('dispose'); return new Response(''); } });
  await host.close(); await host.close();
  assert.equal(log[0].binary, '/sandbox');
  assert.deepEqual(log[0].args, ['-f', '/policy', '/host', 'serve', '--hostname=127.0.0.1', '--port=0', '--print-logs']);
  assert.equal(log[0].options.cwd, root);
  assert.equal(log[0].options.detached, true);
  const env = log[0].options.env;
  assert.equal(env.HOME, '/owned/home');
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
  assert.equal(env.OPENCODE_DISABLE_DEFAULT_PLUGINS, 'true');
  assert.equal(env.OPENCODE_CONFIG, '/native-profile');
  assert.equal('NODE_OPTIONS' in env, false);
  assert.equal('OPENAI_API_KEY' in env, false);
  assert.equal('MEMOCAP_ADDR' in env, false);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT).plugin, [fixtureURL]);
  assert.ok(log.indexOf('dispose') < log.indexOf('SIGTERM'));
  assert.equal(log.filter((item) => item === 'SIGTERM').length, 1);
});

test('cleanup signals only the explicitly owned native process group after disposal', async () => {
  const shared = budget(); const log = []; let owned;
  const fakeSpawn = processFake(log);
  const host = await startHost({ input: { profileRef: '/profile' }, approval, paths, pure: true, budget: shared },
    { spawn: (...args) => { owned = fakeSpawn(...args); owned.pid = 81234; return owned; },
      preloadCheck: (request) => fakePreload(request).proof,
      kill: (group, signal) => { assert.equal(group, -81234); owned.kill(signal); },
      clientFactory: () => ({ _client: { get: async () => ({ data: { version: '1.19.5' } }) },
        config: { get: async () => ({ data: { plugin: [], plugin_origins: [], mcp: {} } }) }, mcp: { status: async () => ({ data: {} }) } }) });
  await host.close();
  assert.equal(log.includes('SIGTERM'), true);
});

test('missing origins without independent preload evidence block even pure startup before generation', async () => {
  const shared = budget(); const log = [];
  assert.deepEqual(JSON.parse(environment({ profileRef: '/profile' }, approval, paths, true).OPENCODE_CONFIG_CONTENT).plugin, []);
  // startHost checks preload synchronously, before its first await.
  await assert.rejects(() => withAuditedAccount(() => startHost({ input: { profileRef: '/profile' }, approval, paths, pure: true, budget: shared },
    { spawn: processFake(log), clientFactory: () => ({ _client: { get: async () => ({ data: { version: '1.19.5' } }) },
      config: { get: async () => ({ data: { mcp: {} } }) }, mcp: { status: async () => ({ data: {} }) } }) })),
  { code: 'preload_preparation_required' });
  assert.equal(log.length, 0);
  assert.equal(shared.snapshot().dispatches, 0);
});

test('native launcher forwards stdin and real bytes but blocks a second write before process execution', () => {
  const shared = budget(); shared.host('nonpure'); shared.root('root', 'user'); shared.child('commit', 'root', 'maintenance_commit');
  const calls = [];
  const value = require('./receipt-fakes.cjs').memoryReceipt();
  Object.assign(value, { operation: 'organize_maintain', status: 'ok', outcome: 'committed', results: [], returned_ids: [], targets: [],
    caller: { actor: 'plugin', session_id: 'commit', message_id: 'native-message' },
    organization: { database: 'offline', action: 'delete', records: [], deleted: [{ id: 4, placement: value.searched_placements[0] }] } });
  const stdout = JSON.stringify(value);
  const execute = (binary, args, options) => { calls.push({ binary, args, options }); return { stdout, status: 0 }; };
  const args = ['--caller-json', JSON.stringify(value.caller), 'organize', 'maintain'];
  const settings = { nativeBinary: '/native', root };
  const dependencies = { budget: shared, execute, stdin: '{"controlled":"request"}', env: {} };
  assert.equal(invokeNative(args, settings, dependencies).stdout, stdout);
  assert.equal(calls[0].options.input, dependencies.stdin);
  assert.equal(shared.snapshot().events.find((event) => event.kind === 'native.dispatch').session, 'commit');
  assert.throws(() => invokeNative(args, settings, dependencies), { code: 'review_write_budget' });
  assert.equal(calls.length, 1);
});

test('unknown native write result is terminal and never replays the write', () => {
  const shared = budget(); shared.host('nonpure'); shared.root('root', 'user'); shared.child('commit', 'root', 'commit');
  let calls = 0;
  const run = () => invokeNative(['--caller-json', '{"session_id":"commit"}', 'remember', 'synthetic'],
    { nativeBinary: '/native', root }, { budget: shared, execute: () => { calls++; return { signal: 'SIGTERM' }; } });
  assert.throws(run, { code: 'native_write_unknown' });
  assert.throws(run, { code: 'native_write_unknown' });
  assert.equal(calls, 1);
});

test('NATIVE-VERIFY-002 accepts the source-defined CLI envelope with the exact plugin caller', () => {
  const shared = budget(); shared.host('nonpure'); shared.root('root', 'user'); shared.child('commit', 'root', 'commit');
  const value = require('./receipt-fakes.cjs').memoryReceipt();
  value.origin = 'cli'; value.caller.session_id = 'commit';
  assert.doesNotThrow(() => invokeNative(['--caller-json', JSON.stringify(value.caller), 'remember', 'synthetic'],
    { nativeBinary: '/native', root }, { budget: shared, execute: () => ({ stdout: JSON.stringify(value), status: 0 }) }));
  assert.equal(shared.snapshot().write_attempts[0].status, 'awaiting_readback');
});

test('NATIVE-VERIFY-001 startup rejection preserves ownership when the spawned fake cannot be stopped', async () => {
  const ownership = { exited: true };
  const fakeSpawn = processFake([]);
  await assert.rejects(() => startHost({ input: { profileRef: '/profile' }, approval, paths,
    pure: true, budget: budget(), ownership }, {
    preloadCheck: (request) => fakePreload(request).proof,
    spawn: (...args) => {
      const child = fakeSpawn(...args);
      child.kill = () => { throw Object.assign(new Error('withheld'), { code: 'EACCES' }); };
      return child;
    },
    clientFactory: () => ({ _client: { get: async () => ({ data: { version: 'wrong' } }) } }),
  }), { code: 'cleanup_signal_failed' });
  assert.equal(ownership.exited, false);
});
