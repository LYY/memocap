const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { sandbox, fixture } = require('./plugin-fixture.cjs');
const { version } = require('../package.json');

async function policyFixture(context) {
  const pkg = await sandbox();
  context.after(pkg.cleanup);
  const bundled = fs.realpathSync(path.join(pkg.root, 'skills/memocap'));
  const directory = path.join(fs.realpathSync(pkg.root), 'managed policy/memocap');
  fs.cpSync(bundled, directory, { recursive: true });
  const input = fixture().input;
  input.client.session.get = async () => ({ data: { directory: pkg.A } });
  return { ...pkg, bundled, directory, input };
}

async function status(hooks) {
  await hooks.config({});
  const parts = [{ type: 'text', messageID: 'command-msg', text: 'placeholder' }];
  const output = { parts };
  await hooks['command.execute.before']({ command: 'memory', sessionID: 'A', arguments: 'status' }, output);
  assert.equal(output.parts, parts);
  return JSON.parse(parts[0].text);
}

test('managed initialization rejects a missing selected source before any sidecar', async (context) => {
  const pkg = await policyFixture(context);
  const directory = path.join(pkg.root, 'missing');
  await assert.rejects(pkg.module.default.server(pkg.input, { skillDirectory: directory }), (error) => {
    assert.equal(error.name, 'PolicyError');
    assert.equal(error.code, 'policy_read');
    assert.equal(error.path, directory);
    assert.equal(error.cause.code, 'ENOENT');
    return true;
  });
  assert.deepEqual(pkg.calls(), []);
});

test('managed source requires an absolute nonempty string', async (context) => {
  const pkg = await policyFixture(context);
  for (const skillDirectory of ['', 'relative/memocap', null, 42]) {
    await assert.rejects(pkg.module.default.server(pkg.input, { skillDirectory }),
      { name: 'PolicyError', code: 'policy_directory' });
  }
});

test('managed malformed markers and invalid UTF8 fail visibly without bundle fallback', async (context) => {
  const pkg = await policyFixture(context);
  const mainPath = path.join(pkg.directory, 'SKILL.md');
  fs.writeFileSync(mainPath, '<!-- memocap:begin --><!-- memocap:end -->');
  await assert.rejects(pkg.module.default.server(pkg.input, { skillDirectory: pkg.directory }),
    { name: 'PolicyError', code: 'policy_markers', path: mainPath });
  fs.writeFileSync(mainPath, Buffer.from([0xff]));
  await assert.rejects(pkg.module.default.server(pkg.input, { skillDirectory: pkg.directory }),
    { name: 'PolicyError', code: 'policy_read', path: pkg.directory });
});

test('complete payload comparison rejects changed, missing and extra reference files at the same version', async (context) => {
  const pkg = await policyFixture(context);
  const reference = path.join(pkg.directory, 'references/instance-test.bin');
  fs.writeFileSync(reference, Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(pkg.bundled, 'references/instance-test.bin'), Buffer.from([1, 2, 3]));
  for (const change of [() => fs.writeFileSync(reference, Buffer.from([3, 2, 1])),
    () => fs.unlinkSync(reference), () => fs.writeFileSync(path.join(pkg.directory, 'extra.bin'), 'extra')]) {
    fs.cpSync(pkg.bundled, pkg.directory, { recursive: true });
    change();
    await assert.rejects(pkg.module.default.server(pkg.input, { skillDirectory: pkg.directory }),
      { name: 'PolicyError', code: 'policy_digest', path: pkg.directory });
  }
});

test('managed missing main preserves the filesystem cause', async (context) => {
  const pkg = await policyFixture(context);
  fs.unlinkSync(path.join(pkg.directory, 'SKILL.md'));
  await assert.rejects(pkg.module.default.server(pkg.input, { skillDirectory: pkg.directory }), (error) => {
    assert.equal(error.name, 'PolicyError');
    assert.equal(error.code, 'policy_read');
    assert.equal(error.cause.code, 'ENOENT');
    return true;
  });
});

test('no option selects only its own complete bundle and reports unregistered bundled provenance', async (context) => {
  const pkg = await policyFixture(context);
  fs.writeFileSync(path.join(pkg.directory, 'SKILL.md'), 'invalid unused managed source');
  const hooks = await pkg.module.default.server(pkg.input);
  context.after(() => hooks.dispose());
  const { inspectPolicy } = await import('../lib/policy.mjs');
  const expected = inspectPolicy(pkg.bundled);
  const rendered = await status(hooks);
  assert.deepEqual(rendered.policy, { mode: 'bundled', directory: expected.directory,
    mainPath: expected.mainPath, version, digest: expected.digest });
  assert.equal(rendered.receipts[0].origin, 'cli');
  assert.equal(rendered.receipts[0].policy, undefined);
});

test('managed reference read failure retains filesystem cause and does not initialize hooks', async (context) => {
  const pkg = await policyFixture(context);
  const reference = path.join(pkg.directory, 'references/read-error.bin');
  fs.writeFileSync(reference, Buffer.from([1]));
  const read = fs.readFileSync;
  const denied = Object.assign(new Error('fixture read denied'), { code: 'EACCES', path: reference });
  const mocked = context.mock.method(fs, 'readFileSync', function (filename, ...args) {
    if (filename === reference) throw denied;
    return read.call(this, filename, ...args);
  });
  try {
    await assert.rejects(pkg.module.default.server(pkg.input, { skillDirectory: pkg.directory }), (error) => {
      assert.equal(error.name, 'PolicyError');
      assert.equal(error.code, 'policy_read');
      assert.equal(error.cause, denied);
      return true;
    });
  } finally { mocked.mock.restore(); }
  assert.deepEqual(pkg.calls(), []);
});

test('two instances from one plugin module keep their selected directories after options mutate', async (context) => {
  const pkg = await policyFixture(context);
  const other = path.join(fs.realpathSync(pkg.root), 'other managed/memocap');
  fs.cpSync(pkg.bundled, other, { recursive: true });
  const options = { skillDirectory: pkg.directory };
  const first = await pkg.module.default.server(pkg.input, options);
  context.after(() => first.dispose());
  options.skillDirectory = other;
  const second = await pkg.module.default.server(pkg.input, options);
  context.after(() => second.dispose());
  assert.equal((await status(first)).policy.directory, pkg.directory);
  assert.equal((await status(second)).policy.directory, other);
  assert.equal((await status(first)).policy.directory, pkg.directory);
});

test('two packages select independent managed rules and retain immutable initialization snapshots', async (context) => {
  const first = await policyFixture(context);
  const second = await policyFixture(context);
  for (const [pkg, newline] of [[first, '\n'], [second, '\r\n']]) {
    const main = path.join(pkg.bundled, 'SKILL.md');
    const bytes = fs.readFileSync(main, 'utf8').replace(/\r?\n/g, newline);
    fs.writeFileSync(main, bytes);
    fs.writeFileSync(path.join(pkg.directory, 'SKILL.md'), bytes);
  }
  fs.cpSync(second.bundled, second.directory, { recursive: true });
  const { inspectPolicy } = await import('../lib/policy.mjs');
  const snapshots = [inspectPolicy(first.directory), inspectPolicy(second.directory)];
  assert.notEqual(snapshots[0].digest, snapshots[1].digest);
  const hooks = await Promise.all([first, second].map((pkg) =>
    pkg.module.default.server(pkg.input, { skillDirectory: pkg.directory })));
  for (const current of hooks) context.after(() => current.dispose());
  for (const pkg of [first, second]) fs.writeFileSync(path.join(pkg.directory, 'SKILL.md'), 'changed after initialization');
  for (const index of [1, 0, 1]) {
    const rendered = await status(hooks[index]);
    const expected = snapshots[index];
    assert.deepEqual(rendered.policy, { mode: 'managed', directory: expected.directory,
      mainPath: expected.mainPath, version, digest: expected.digest });
    const compact = { context: [] };
    await hooks[index]['experimental.session.compacting']({ sessionID: 'A' }, compact);
    assert.deepEqual(compact.context, [expected.rules]);
  }
});

test('policy loader freezes rules handoff and exact provenance keys', async (context) => {
  const pkg = await policyFixture(context);
  const { loadPolicy } = await import(pathToFileURL(path.join(pkg.root, 'plugin/policy.js')).href);
  const selected = loadPolicy({ skillDirectory: pkg.directory });
  assert.ok(Object.isFrozen(selected));
  assert.ok(Object.isFrozen(selected.provenance));
  assert.deepEqual(Object.keys(selected).sort(), ['provenance', 'rules']);
  assert.deepEqual(Object.keys(selected.provenance).sort(), ['digest', 'directory', 'mainPath', 'mode', 'version']);
  assert.equal(Reflect.set(selected.provenance, 'directory', pkg.bundled), false);
});
