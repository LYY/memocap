const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNative, fixtures } = require('./controller.cjs');
const { prepareOwnedPreload } = require('./preload-preparation.cjs');
const { CanaryBlocked } = require('./entry.cjs');
const { memoryReceipt, successfulResult } = require('./receipt-fakes.cjs');
const { invokeNative } = require('./native-proxy.cjs');

for (const scenario of ['verified', 'unknown-exit', 'unknown-write', 'restore-failed']) {
  test(`owned filesystem wiring retains the correct data when ${scenario}`, async () => {
    const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memocap-wiring-'));
    const input = { enabled: true, profileRef: '/synthetic-profile', credentialRef: 'synthetic-label',
      consent: 'quality-native-canary-v1:fresh-bounded-runtime', providerDestinations: ['https://provider.invalid/responses'],
      authDestinations: [], existingCapability: true, approvalRef: '/synthetic-approval',
      attemptFile: path.join(parent, 'attempt.json'), privateRoot: path.join(parent, 'owned') };
    const log = [];
    let prepared;
    let sequence = 0;
    const directoryModes = () => prepared.directories.map((directory) => fs.statSync(directory).mode & 0o777);
    try {
      const report = await runNative(input, { fixtures: () => fixtures(),
        approve: () => ({ batch: 'offline-fs', fingerprint: 'synthetic', native: { path: '/synthetic-native' }, model: {} }),
        preparePreload: (owned, paths, io) => {
          log.push('prepare');
          prepared = prepareOwnedPreload(owned, paths, io);
          return { ...prepared, recheck: () => { log.push('recheck'); return prepared.recheck(); },
            restore: () => {
              log.push('restore');
              if (scenario === 'restore-failed') throw new CanaryBlocked('preload_owned_identity_changed');
              prepared.restore(); assert.deepEqual(directoryModes(), [0o700, 0o700]);
            } };
        },
        startHost: async ({ pure, budget }) => {
          assert.equal(log.at(-1), 'recheck');
          log.push(pure ? 'pure.spawn.fake' : 'task.spawn.fake');
          if (pure) fs.writeFileSync(path.join(input.privateRoot, 'sentinel.txt'), 'synthetic owned evidence', { flag: 'wx' });
          assert.deepEqual(directoryModes(), [0o500, 0o500]);
          for (const directory of prepared.directories) {
            assert.throws(() => fs.accessSync(directory, fs.constants.W_OK), { code: 'EACCES' });
          }
          budget.host(pure ? 'pure' : 'nonpure');
          if (!pure && scenario === 'unknown-exit') throw new CanaryBlocked('cleanup_exit_unknown');
          return { close: async () => { log.push(pure ? 'pure.exit' : 'task.exit'); }, client: { session: {
            create: async () => ({ data: { id: `session-${++sequence}` } }), abort: async () => ({}),
            prompt: async (request) => {
              const session = request.path.id;
              budget.root(session, 'user', budget.snapshot().active?.slot);
              if (!budget.snapshot().active?.slot) {
                const caller = { actor: 'plugin', session_id: `${session}-commit`, message_id: 'commit-user' };
                budget.child(caller.session_id, session, 'commit');
                invokeNative(['--caller-json', JSON.stringify(caller), 'remember', 'synthetic'],
                  { nativeBinary: '/synthetic', root: '/synthetic' }, { budget, execute: () => scenario === 'unknown-write'
                    ? { signal: 'SIGTERM' } : successfulResult(memoryReceipt()) });
              }
              budget.event({ kind: 'capture.terminal', session, user: 'user', status: 'skipped' });
              return { data: { info: { finish: 'stop' } } };
            }, messages: async () => ({ data: [] }),
          } } };
        },
        invokeNative: () => { log.push('verified-read'); return successfulResult(memoryReceipt('read')); },
      });
      assert.deepEqual(log.filter((event) => event === 'prepare'), ['prepare']);
      assert.equal(log.includes('task.spawn.fake'), true);
      assert.equal(report.cleanup.private_root_removed, scenario === 'verified');
      assert.equal(fs.existsSync(input.attemptFile), true);
      if (scenario === 'verified') {
        assert.ok(log.indexOf('restore') > log.indexOf('task.exit'));
        assert.ok(log.indexOf('restore') > log.indexOf('verified-read'));
        assert.equal(fs.existsSync(input.privateRoot), false);
      } else {
        assert.equal(fs.existsSync(input.privateRoot), true);
        assert.equal(fs.readFileSync(path.join(input.privateRoot, 'sentinel.txt'), 'utf8'), 'synthetic owned evidence');
        assert.deepEqual(directoryModes(), [0o500, 0o500]);
        assert.equal(log.includes('restore'), scenario === 'restore-failed');
        if (scenario === 'restore-failed') assert.equal(report.cleanup.permissions_restore, 'failed');
      }
    } finally {
      if (fs.existsSync(input.privateRoot)) prepared?.restore();
      fs.rmSync(parent, { recursive: true });
    }
    assert.equal(fs.existsSync(parent), false);
  });
}

for (const mutation of ['home-discovery', 'config-content', 'ignore-replaced', 'writable', 'symlink']) {
  test(`prepared filesystem recheck blocks ${mutation} without a second preparation`, () => {
    const owned = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memocap-recheck-'));
    const paths = { home: path.join(owned, 'home'), config: path.join(owned, 'config') };
    let prepared;
    try {
      fs.mkdirSync(paths.home, { mode: 0o700 }); fs.mkdirSync(paths.config, { mode: 0o700 });
      prepared = prepareOwnedPreload(owned, paths);
      if (mutation === 'home-discovery') fs.mkdirSync(path.join(paths.home, '.opencode'));
      if (mutation === 'writable') fs.chmodSync(paths.config, 0o700);
      if (mutation === 'config-content' || mutation === 'symlink') {
        fs.chmodSync(paths.config, 0o700);
        if (mutation === 'symlink') fs.symlinkSync(paths.home, path.join(paths.config, 'plugins'));
        else fs.writeFileSync(path.join(paths.config, 'opencode.json'), '{}');
        fs.chmodSync(paths.config, 0o500);
      }
      if (mutation === 'ignore-replaced') fs.writeFileSync(path.join(paths.config, '.gitignore'), 'changed');
      assert.throws(() => prepared.recheck(), CanaryBlocked);
    } finally { prepared?.restore(); fs.rmSync(owned, { recursive: true }); }
  });
}
