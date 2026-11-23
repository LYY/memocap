const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
const { hash, TransportBlocked } = require('./value.cjs');
const { selection, endpoint } = require('./selected-provider-fixture.cjs');
const isolation = { kind: 'ordinary-host-v1', permissions: 'ordinary-os-account', os_file_network_restrictions: false };

test('launch uses direct pinned host argv and literal environment with confirmed group cleanup', async () => {
  const child = new EventEmitter(); child.pid = 123;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const calls = []; const kills = [];
  const environment = { HOME: '/synthetic/home', XDG_CONFIG_HOME: '/synthetic/config', MEMOCAP_DB: '/synthetic/db' };
  const state = require('./process.cjs').launch({ host: { path: '/synthetic/pinned-host' },
    sandbox: { path: '/old/sandbox', policy: { path: '/old/policy' } },
    environment, project: '/synthetic/project', server: 'http://127.0.0.1:49173' }, {
    spawn(file, argv, options) { calls.push({ file, argv, options }); return child; },
    kill(pid, signal) {
      kills.push([pid, signal]);
      if (signal === 0) throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
      child.emit('close', 0, null);
    },
  });
  child.stdout.write('opencode server listening on http://127.0.0.1:49173');
  await state.ready;
  assert.deepEqual(await Promise.all([state.close(), state.close()]), [true, true]);
  assert.equal(await state.close(), true);
  assert.deepEqual(state.closeEvidence, { leader_closed: true, pgid: 123, group_probe: 'ESRCH' });
  const result = await require('./cleanup.cjs').cleanupOwned({ process: state,
    private: { close({ retain_recovery }) { return { removed: !retain_recovery }; } } }, {});
  assert.equal(result.removed, true); assert.equal(result.children, 0);
  assert.deepEqual(calls, [{ file: '/synthetic/pinned-host', argv: ['serve', '--hostname=127.0.0.1', '--port=49173'],
    options: { cwd: '/synthetic/project', env: environment, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] } }]);
  assert.deepEqual(kills, [[123, 'SIGTERM'], [123, 0]]);
});

for (const outcome of ['present', 'EPERM', 'unknown']) {
  test(`cleanup retains recovery after leader close when process group proof is ${outcome}`, async () => {
    const child = new EventEmitter(); child.pid = 123;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const signals = [];
    const host = require('./process.cjs').launch({ host: { path: '/inert/host' },
      project: '/inert', environment: {}, server: 'http://127.0.0.1:49173' }, {
      spawn() { return child; },
      kill(pid, signal) {
        signals.push([pid, signal]);
        if (signal !== 0) return;
        if (outcome !== 'present') throw Object.assign(new Error('inert probe failure'), { code: outcome });
      },
    });
    child.stdout.write('opencode server listening on http://127.0.0.1:49173');
    await host.ready;
    child.emit('exit', 0, null);
    const closing = require('./cleanup.cjs').cleanupOwned({ process: host,
      private: { close({ retain_recovery }) { return { removed: !retain_recovery }; } } }, {});
    setImmediate(() => child.emit('close', 0, null));
    const result = await closing;
    assert.equal(result.removed, false);
    assert.equal(result.exited, true);
    assert.equal(result.children, null);
    assert.equal(result.error, 'process_group_unconfirmed');
    assert.deepEqual(result.process_evidence, { leader_closed: true, pgid: 123, group_probe: outcome });
    assert.ok(signals.length > 0);
    assert.ok(signals.every(([pid, signal]) => pid === 123 && signal === 0));
    if (outcome !== 'present') assert.equal(signals.length, 1);
  });
}

test('termination permission failure retains evidence without sending another signal', async () => {
  const child = new EventEmitter(); child.pid = 123;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const signals = [];
  const host = require('./process.cjs').launch({ host: { path: '/inert/host' },
    project: '/inert', environment: {}, server: 'http://127.0.0.1:49173' }, {
    spawn() { return child; },
    kill(_pid, signal) { signals.push(signal); throw Object.assign(new Error('inert permission error'), { code: 'EPERM' }); },
  });
  child.stdout.write('opencode server listening on http://127.0.0.1:49173');
  await host.ready;
  const result = await require('./cleanup.cjs').cleanupOwned({ process: host,
    private: { close({ retain_recovery }) { return { removed: !retain_recovery }; } } }, {});
  await assert.rejects(host.close(), { code: 'process_group_term_failed' });
  assert.equal(result.removed, false);
  assert.equal(result.children, null);
  assert.deepEqual(result.process_evidence, { leader_closed: false, pgid: 123, group_probe: 'not_probed', term_error: 'EPERM' });
  assert.deepEqual(signals, ['SIGTERM']);
});

function admission(selectedVersion) {
  const reads = []; const bytes = Buffer.from('synthetic artifact');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const inventory = require('./inventory.cjs').inventory();
  const artifact = (name, version) => ({ path: `/synthetic/${name}`, sha256: digest, version });
  const input = { isolation, network_binding: selection(), endpoints: [endpoint], profile: {},
    host: artifact('host', '1.19.5'), native: artifact('native', '0.7.0'), node: artifact('node', '26.13.0'),
    paths: { server: 'http://127.0.0.1:49173', privateRoot: '/synthetic/private', attempt: '/synthetic/attempt',
      case_roots: Array.from({ length: 28 }, (_, index) => `/synthetic/private/run-${index + 1}`) } };
  const grant = { kind: 'quality-full-population-native-v1', approved: true, authorization: 'new-explicit-user-grant',
    mode: 'native', approval_id: 'offline-selection-only', isolation, network_binding: input.network_binding,
    inventory_sha256: hash(inventory), population_sha256: inventory.tuning_sha256, limits: inventory.limits,
    source_sha256: 'source', profile_sha256: hash(input.profile),
    paths: input.paths, endpoints: input.endpoints, host: input.host, native: input.native, node: input.node,
    host_source_audit: 'exact-1.19.5-810c0eba1a7348036f8bdf61e6632d0c36c6876c',
    api_key_only: true, no_refresh: true, private_preload_reviewed: true };
  let audit; let realpath = '/synthetic/physical-host'; let hostBytes = bytes;
  if (selectedVersion !== undefined) {
    Object.assign(input.host, { version: selectedVersion, realpath });
    grant.kind = 'quality-full-population-native-selected-v1-r8'; grant.authorization = 'approved-work';
    audit = Buffer.from(JSON.stringify({ schema: 1, kind: 'opencode-v1-source-audit', batch: grant.approval_id,
      verdict: 'approved', host: input.host, source_revision: 'c'.repeat(40),
      version_probe: { argv: [input.host.path, '--version'], status: 0, stderr: '', stdout: `${selectedVersion}\n` } }));
    input.host_source_audit = grant.host_source_audit = { path: '.omo/inert-audit.json', sha256: createHash('sha256').update(audit).digest('hex') };
  }
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, 'authorization.cjs'), 'utf8').replace('function sources() {', 'function unusedSources() {');
  vm.compileFunction(`const sources = () => ({digest: 'source'});\n${source}`, ['require', 'module', '__dirname', 'URL', 'structuredClone'])(
     (name) => name === 'node:fs' ? { existsSync() { reads.push('exists'); return false; }, realpathSync: () => realpath,
       readFileSync(file) {
         reads.push(file);
         if (file === path.resolve(__dirname, '../../.omo/inert-audit.json')) return audit;
         if (file === '/synthetic/physical-host' || file === '/synthetic/host') return hostBytes;
         assert.ok(['/synthetic/native', '/synthetic/node'].includes(file)); return bytes;
       } } :
      name === './inventory.cjs' ? { inventory: () => inventory } :
        name === '../capture-quality-native/approval.cjs' ? { validateProfile() {} } : require(name),
    module, __dirname, URL, structuredClone);
  return { input: structuredClone(input), grant: structuredClone(grant), reads, ...module.exports,
    drift(kind) {
      if (kind === 'path') realpath = '/synthetic/other-host';
      if (kind === 'bytes') hostBytes = Buffer.from('other inert artifact');
      if (kind === 'audit') audit = Buffer.from('{}');
    } };
}
test('ordinary descriptor admits exact bound grant with only host native Node artifacts', () => {
  const current = admission(); const admitted = current.authorize(current.input, current.grant);
  assert.equal(admitted.approved, true);
  assert.deepEqual(current.reads, ['exists', 'exists', '/synthetic/host', '/synthetic/native', '/synthetic/node']);
});
for (const change of ['missing', 'mismatch', 'sandbox']) test(`${change} isolation rejects before filesystem effects`, () => {
  const current = admission();
  if (change === 'missing') delete current.input.isolation;
  if (change === 'mismatch') current.grant.isolation.permissions = 'different';
  if (change === 'sandbox') {
    delete current.input.isolation; delete current.grant.isolation;
    current.input.sandbox = {}; current.grant.sandbox = {}; current.grant.sandbox_reviewed = true;
  }
  assert.throws(() => current.authorize(current.input, current.grant), { code: 'ordinary_host_isolation_required' });
  assert.deepEqual(current.reads, []);
});
for (const dimension of ['source_sha256', 'inventory_sha256', 'profile_sha256', 'paths']) test(`ordinary isolation preserves ${dimension} binding`, () => {
  const current = admission(); current.grant[dimension] = 'changed';
  assert.throws(() => current.authorize(current.input, current.grant), { code: 'population_grant_binding' });
  assert.deepEqual(current.reads, []);
});

test('selected-v1 admission accepts an audited v1 without enabling it on the legacy entry', () => {
  const current = admission('1.41.2');
  assert.throws(() => current.authorize(current.input, current.grant), { code: 'new_exact_population_grant_required' });
  const approved = current.authorizeSelectedV1(current.input, current.grant);
  assert.deepEqual(current.selectedV1Host(approved), current.input.host);
  assert.throws(() => current.selectedV1Host(structuredClone(approved)), { code: 'new_exact_population_grant_required' });
});

test('selected-v1 admission rejects v2 despite matching artifact and audit bindings', () => {
  const current = admission('2.0.0');
  assert.throws(() => current.authorizeSelectedV1(current.input, current.grant), { code: 'exact_runtime_required' });
});

test('selected-v1 requires audit contents to identify the same host, even when the audit digest matches', () => {
  const current = admission('1.41.2');
  current.input.host.version = current.grant.host.version = '1.41.3';
  assert.throws(() => current.authorizeSelectedV1(current.input, current.grant), { code: 'selected_host_audit_identity' });
});

test('selected-v1 artifact recheck rejects physical path, executable byte and audit byte drift', async (t) => {
  for (const [kind, code] of [['path', 'selected_host_artifact_changed'], ['bytes', 'selected_host_artifact_changed'],
    ['audit', 'selected_host_audit_changed']]) await t.test(kind, () => {
    const current = admission('1.41.2');
    const approved = current.authorizeSelectedV1(current.input, current.grant);
    current.drift(kind);
    assert.throws(() => current.recheckSelectedV1Host(approved), { code });
  });
});

test('selected-v1 adapter accepts only its admitted exact session version', async (t) => {
  const filename = path.join(__dirname, 'adapter.cjs');
  for (const [version, reason] of [['1.41.2', 'inert_delivery'], ['1.19.5', 'native_session_identity'],
    ['1.41.3', 'native_session_identity'], ['2.0.0', 'native_session_identity']]) await t.test(version, async () => {
    const current = admission('1.41.2');
    const module = { exports: {} };
    vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module'],
      { filename, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })(
      (name) => name === './authorization.cjs' ? current : require(name), module);
    const budget = current.authorizeSelectedV1(current.input, current.grant);
    const host = { mode: 'native', async open() {
      return { sessionID: 'inert-root', origin: 'inert-origin', root: '/synthetic/project', node: '/inert/node', version };
    }, async deliver() { throw new TransportBlocked('inert_delivery'); },
    async close() { return { exited: true, children: 0, removed: false }; } };
    const result = await module.exports.runCase('unicode-preference', { host, budget });
    assert.equal(result.reason, reason);
  });
});

test('capture fixture resolves an explicit v1 pair without changing the legacy routes', async (t) => {
  const filename = path.resolve(__dirname, '../opencode-capture/harness.cjs');
  for (const [label, env, observed, executable, expected] of [
    ['explicit', { MEMOCAP_CAPTURE_HOST_EXECUTABLE: '/inert/link', MEMOCAP_CAPTURE_HOST_EXPECTED_VERSION: '1.41.2' },
      '1.41.2', '/inert/physical', /inert_launch/],
    ['missing version', { MEMOCAP_CAPTURE_HOST_EXECUTABLE: '/inert/link' }, '1.19.5', undefined, /must be set together/],
    ['mismatch', { MEMOCAP_CAPTURE_HOST_EXECUTABLE: '/inert/link', MEMOCAP_CAPTURE_HOST_EXPECTED_VERSION: '1.41.2' },
      '1.41.3', undefined, /exact fixture version/],
    ['v2', { MEMOCAP_CAPTURE_HOST_EXECUTABLE: '/inert/link', MEMOCAP_CAPTURE_HOST_EXPECTED_VERSION: '2.0.0' },
      '2.0.0', undefined, /OpenCode v1/],
    ['default', {}, '1.19.5', '/opt/homebrew/bin/opencode', /inert_launch/],
    ['packaged', { MEMOCAP_CAPTURE_PACKAGED_HOST: '1' }, '1.19.3', '/inert/packaged', /inert_launch/],
  ]) await t.test(label, async () => {
    const module = { exports: {} }; const local = require('node:module').createRequire(filename);
    const resource = { url: 'inert', releaseAll() {}, async close() {} };
    let launched;
    const deps = { 'node:fs': { existsSync: () => false, realpathSync: () => '/inert/physical', readFileSync: () => Buffer.from('inert'), chmodSync() {} },
      '../setup-package-lifecycle-fixture.cjs': { write() {}, digest: (bytes) => createHash('sha256').update(bytes).digest('hex'),
        lifecycleFixture: () => ({ root: '/inert', home: '/inert/home', version: '0.7.0', env: { XDG_CONFIG_HOME: '/inert/config' },
          async prepare({ installPackagedHost = true } = {}) {
            if (env.MEMOCAP_CAPTURE_HOST_EXECUTABLE && installPackagedHost) throw new TransportBlocked('historical_bootstrap_requested');
            return { runnerRoot: '/inert/package', host: installPackagedHost ? '/inert/packaged' : undefined };
          },
          async command(file) { return { stdout: file === '/inert/physical' || !env.MEMOCAP_CAPTURE_HOST_EXECUTABLE ? observed : '1.19.5' }; }, async cleanup() {} }) },
      '../opencode-v1/host.cjs': { async wireProvider() { return resource; }, async portClosed() { return true; },
        async startHost(value) { launched = value.host; throw new TransportBlocked('inert_launch'); } },
      '../opencode-capture-spike/control.cjs': { async controlServer() { return resource; } } };
    vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', '__dirname', 'process'], { filename })(
      (name) => deps[name] ?? local(name), module, path.dirname(filename), { env, execPath: '/inert/node' });
    await assert.rejects(module.exports.harness({ cleanup: {} }), expected);
    assert.equal(launched, executable);
  });
});
