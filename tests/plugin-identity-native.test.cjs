const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, fixture } = require('./plugin-fixture.cjs');

test('native plugin selects primary and linked worktree together and recalls their shared memory',
  { skip: process.env.MEMOCAP_IDENTITY_NATIVE !== '1' }, async (context) => {
    const current = await sandbox();
    context.after(current.cleanup);
    const native = path.resolve(__dirname, '../target/debug', process.platform === 'win32' ? 'memocap.exe' : 'memocap');
    for (const file of ['cli.cjs', 'cache-lock.cjs']) fs.copyFileSync(path.resolve(__dirname, '../bin', file), path.join(current.root, 'bin', file));
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: current.root,
      GIT_MASTER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(current.root, 'gitconfig'),
      MEMOCAP_HOME: current.root, MEMOCAP_DB: path.join(current.root, 'native.db'), MEMOCAP_BINARY: native };
    context.mock.property(process, 'env', Object.fromEntries(Object.entries(env).filter(([, entry]) => entry !== undefined)));
    for (const argv of [
      ['init', '--quiet', current.A],
      ['-C', current.A, '-c', 'user.name=Identity Test', '-c', 'user.email=identity@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'],
      ['-C', current.A, 'worktree', 'add', '--quiet', '--detach', path.join(current.root, 'linked')],
    ]) {
      const response = spawnSync('git', argv, { cwd: current.root, env: process.env, encoding: 'utf8', timeout: 5000 });
      assert.equal(response.status, 0, response.stderr);
    }
    const host = fixture();
    host.input.client.session.get = async () => ({ data: { directory: current.A } });
    const hooks = await current.module.default.server(host.input);
    context.after(() => hooks.dispose());
    const asks = [];
    const toolContext = { sessionID: 'A', messageID: 'native-worktrees', abort: new AbortController().signal,
      metadata() {}, ask: async (permission) => { asks.push(permission); } };
    const execute = async (name, args) => JSON.parse((await hooks.tool[`memocap_${name}`].execute(args, toolContext)).output);
    const saved = await execute('remember', { content: 'linkedcheckoutanchor shared repository memory' });
    assert.equal(saved.status, 'inserted', JSON.stringify(saved));
    assert.equal(saved.readback.status, 'ok', JSON.stringify(saved));
    const paths = [current.A, path.join(current.root, 'linked')];

    const selected = await execute('scope', { paths, query: 'linkedcheckoutanchor' });

    assert.equal(selected.status, 'ok', JSON.stringify(selected));
    assert.deepEqual(selected.targets.map((target) => target.canonical_path), paths.map((directory) => fs.realpathSync(directory)));
    assert.deepEqual(selected.targets.map((target) => target.repository_id), Array(2).fill(saved.targets[0].repository_id));
    assert.deepEqual(selected.returned_ids, saved.returned_ids);
    assert.deepEqual(asks[1].metadata.targets, selected.targets.map((target) => ({
      ...target, placements: [target.repository_id],
    })));
    assert.ok(Object.isFrozen(asks[1].metadata.targets));
    const recalled = await execute('recall', { query: 'linkedcheckoutanchor' });
    assert.deepEqual(recalled.targets, selected.targets);
    assert.deepEqual(recalled.returned_ids, saved.returned_ids);
    const asksBeforeWrite = asks.length;
    assert.equal((await execute('remember', { content: 'no combined write' })).status, 'failed');
    assert.equal(asks.length, asksBeforeWrite);
  });

test('native plugin freezes symlink identity before permission and uses IDs after every checkout disappears',
  { skip: process.env.MEMOCAP_IDENTITY_NATIVE !== '1' }, async (context) => {
    const current = await sandbox();
    context.after(current.cleanup);
    const native = path.join(current.root, process.platform === 'win32' ? 'native.exe' : 'native');
    fs.copyFileSync(path.resolve(__dirname, '../target/debug', process.platform === 'win32' ? 'memocap.exe' : 'memocap'), native);
    for (const file of ['cli.cjs', 'cache-lock.cjs']) fs.copyFileSync(path.resolve(__dirname, '../bin', file), path.join(current.root, 'bin', file));
    const alias = path.join(current.root, 'selected');
    fs.symlinkSync(fs.realpathSync(current.A), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const database = path.join(fs.realpathSync(current.root), 'native.db');
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: current.root,
      MEMOCAP_HOME: current.root, MEMOCAP_DB: '../native.db', MEMOCAP_BINARY: native };
    context.mock.property(process, 'env', Object.fromEntries(Object.entries(env).filter(([, entry]) => entry !== undefined)));
    const cli = (argv) => {
      const response = spawnSync(native, ['--json', ...argv], { cwd: current.root,
        env: { ...process.env, MEMOCAP_DB: database }, encoding: 'utf8', shell: false, timeout: 5000 });
      assert.equal(response.status, 0, response.stderr);
      return JSON.parse(response.stdout);
    };
    const originalID = cli(['scope', 'resolve', '--repo', alias]).targets[0].repository_id;
    const replacementID = cli(['scope', 'resolve', '--repo', current.B]).targets[0].repository_id;
    const host = fixture();
    host.input.client.session.get = async () => ({ data: { directory: current.A } });
    const previousCwd = process.cwd();
    let hooks;
    try {
      process.chdir(current.A);
      hooks = await current.module.default.server(host.input);
    } finally { process.chdir(previousCwd); }
    context.after(() => hooks.dispose());
    const toolContext = { sessionID: 'A', messageID: 'native-identity', abort: new AbortController().signal,
      metadata() {}, ask: async (permission) => {
        assert.deepEqual(permission.patterns, [originalID]);
        fs.unlinkSync(alias);
        fs.symlinkSync(fs.realpathSync(current.B), alias, process.platform === 'win32' ? 'junction' : 'dir');
      } };
    const execute = async (name, args) => JSON.parse((await hooks.tool[`memocap_${name}`].execute(args, toolContext)).output);
    const selected = await execute('scope', { paths: [alias] });
    assert.equal(selected.status, 'empty', JSON.stringify(selected));
    assert.equal(selected.targets[0].repository_id, originalID);
    toolContext.ask = async (permission) => assert.deepEqual(permission.patterns, [originalID]);
    fs.unlinkSync(alias);
    fs.rmSync(current.A, { recursive: true });
    fs.rmSync(current.B, { recursive: true });
    const saved = await execute('remember', { content: 'nativeidentityanchor remains reachable without locations' });
    assert.equal(saved.status, 'inserted', JSON.stringify(saved));
    assert.equal(saved.readback.status, 'ok', JSON.stringify(saved));
    assert.equal(saved.targets[0].repository_id, originalID);
    const recalled = await execute('recall', { query: 'nativeidentityanchor' });
    assert.deepEqual(recalled.returned_ids, saved.returned_ids);
    assert.equal(recalled.repository_context[originalID].locations[0].canonical_path, selected.targets[0].canonical_path);
    assert.ok(recalled.repository_context[originalID].identity.display_name);
    assert.equal(fs.existsSync(database), true);
    const missing = await execute('scope', { paths: [current.A] });
    assert.equal(missing.status, 'failed');
    toolContext.ask = async (permission) => assert.deepEqual(permission.patterns, [replacementID]);
    const switched = await execute('scope', { repository_ids: [replacementID] });
    assert.equal(switched.status, 'empty', JSON.stringify(switched));
    const idOnly = await execute('remember', { content: 'idonlyanchor has no descriptor' });
    assert.equal(idOnly.readback.status, 'ok', JSON.stringify(idOnly));
    assert.deepEqual(idOnly.repository_context[replacementID], { identity: null, locations: [] });
    assert.deepEqual(cli(['list', '--repository-id', originalID]).returned_ids, saved.returned_ids);
    assert.deepEqual(cli(['list', '--repository-id', replacementID]).returned_ids, idOnly.returned_ids);
  });
