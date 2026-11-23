const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fakeFixture() {
  let inode = 0;
  const nodes = new Map();
  const mutations = [];
  const paths = { home: '/owned/home', config: '/owned/config' };
  const add = (file, kind = 'directory', mode = 0o700) => nodes.set(file, {
    kind, mode, uid: process.getuid(), dev: 1, ino: ++inode,
  });
  for (const file of ['/owned', paths.home, paths.config]) add(file);
  const failure = (code) => Object.assign(new Error(code), { code });
  const io = {
    lstatSync(file) {
      const node = nodes.get(file);
      if (!node) throw failure('ENOENT');
      return { ...node, isDirectory: () => node.kind === 'directory', isFile: () => node.kind === 'file',
        isSymbolicLink: () => node.kind === 'symlink' };
    },
    realpathSync: (file) => file,
    readFileSync: (file) => nodes.get(file).bytes,
    readdirSync: (file) => [...nodes.keys()].filter((key) => path.dirname(key) === file)
      .map((key) => path.basename(key)),
    mkdirSync(file) { if (nodes.has(file)) throw failure('EEXIST'); add(file); mutations.push(['mkdir', file]); },
    writeFileSync(file, bytes, options) {
      assert.equal(options.flag, 'wx');
      if (nodes.has(file)) throw failure('EEXIST');
      add(file, 'file', options.mode); nodes.get(file).bytes = bytes; mutations.push(['write', file]);
    },
    chmodSync(file, mode) { nodes.get(file).mode = mode; mutations.push(['chmod', file, mode]); },
    accessSync(file, mode) {
      assert.equal(mode, fs.constants.W_OK);
      if (!(nodes.get(file).mode & 0o222)) throw failure('EACCES');
    },
  };
  return { io, paths, nodes, mutations, add };
}

test('prepares both install directories before refusing writes and restores original modes', () => {
  const fixture = fakeFixture();
  const { prepareOwnedPreload } = require('./preload-preparation.cjs');
  const prepared = prepareOwnedPreload('/owned', fixture.paths, fixture.io);
  assert.deepEqual(prepared.directories, ['/owned/config/opencode', '/owned/config']);
  for (const directory of prepared.directories) {
    assert.throws(() => fixture.io.accessSync(directory, fs.constants.W_OK), { code: 'EACCES' });
    assert.equal(fixture.nodes.get(`${directory}/.gitignore`).bytes,
      'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore');
  }
  const firstMode = fixture.mutations.findIndex(([operation]) => operation === 'chmod');
  assert.equal(fixture.mutations.slice(0, firstMode).filter(([operation]) => operation === 'write').length, 2);
  prepared.restore();
  for (const directory of prepared.directories) assert.equal(fixture.nodes.get(directory).mode, 0o700);
  assert.equal(fixture.nodes.has('/owned/home/.opencode'), false);
});

for (const [name, mutate] of [
  ['outside config', (fixture) => { fixture.paths.config = '/foreign'; }],
  ['outside home', (fixture) => { fixture.paths.home = '/foreign'; }],
  ['symlink root', (fixture) => { fixture.nodes.get('/owned').kind = 'symlink'; }],
  ['symlink config', (fixture) => { fixture.nodes.get('/owned/config').kind = 'symlink'; }],
  ['symlink home', (fixture) => { fixture.nodes.get('/owned/home').kind = 'symlink'; }],
  ['symlink ancestor', (fixture) => { fixture.io.realpathSync = () => '/foreign'; }],
  ['foreign root', (fixture) => { fixture.nodes.get('/owned').uid++; }],
  ['foreign config', (fixture) => { fixture.nodes.get('/owned/config').uid++; }],
  ['shared root', (fixture) => { fixture.nodes.get('/owned').mode = 0o777; }],
  ['existing config content', (fixture) => { fixture.add('/owned/config/keep', 'file'); }],
  ['existing home .opencode', (fixture) => { fixture.add('/owned/home/.opencode'); }],
]) {
  test(`rejects ${name} before any write or mode change`, () => {
    const fixture = fakeFixture();
    mutate(fixture);
    const { prepareOwnedPreload } = require('./preload-preparation.cjs');
    assert.throws(() => prepareOwnedPreload('/owned', fixture.paths, fixture.io), { code: 'preload_owned_layout_required' });
    assert.deepEqual(fixture.mutations, []);
  });
}

test('fails closed and restores modes when current user retains write access', () => {
  const fixture = fakeFixture();
  fixture.io.accessSync = () => {};
  const { prepareOwnedPreload } = require('./preload-preparation.cjs');
  assert.throws(() => prepareOwnedPreload('/owned', fixture.paths, fixture.io), { code: 'preload_config_still_writable' });
  for (const file of ['/owned/config', '/owned/config/opencode']) assert.equal(fixture.nodes.get(file).mode, 0o700);
});

test('propagates unexpected access failure after restoring modes', () => {
  const fixture = fakeFixture();
  fixture.io.accessSync = () => { throw Object.assign(new Error('I/O'), { code: 'EIO' }); };
  const { prepareOwnedPreload } = require('./preload-preparation.cjs');
  assert.throws(() => prepareOwnedPreload('/owned', fixture.paths, fixture.io), { code: 'EIO' });
  for (const file of ['/owned/config', '/owned/config/opencode']) assert.equal(fixture.nodes.get(file).mode, 0o700);
});

test('restore refuses replaced owned directories before changing modes', () => {
  const fixture = fakeFixture();
  const { prepareOwnedPreload } = require('./preload-preparation.cjs');
  const prepared = prepareOwnedPreload('/owned', fixture.paths, fixture.io);
  fixture.nodes.get('/owned/config/opencode').ino++;
  const before = fixture.mutations.length;
  assert.throws(() => prepared.restore(), { code: 'preload_owned_identity_changed' });
  assert.equal(fixture.mutations.length, before);
});

test('restores the first directory when the second chmod fails', () => {
  const fixture = fakeFixture();
  const chmod = fixture.io.chmodSync;
  let failed = false;
  fixture.io.chmodSync = (file, mode) => {
    if (file === '/owned/config' && mode === 0o500 && !failed) {
      failed = true;
      throw Object.assign(new Error('chmod failed'), { code: 'EIO' });
    }
    chmod(file, mode);
  };
  const { prepareOwnedPreload } = require('./preload-preparation.cjs');
  assert.throws(() => prepareOwnedPreload('/owned', fixture.paths, fixture.io), { code: 'EIO' });
  for (const file of ['/owned/config', '/owned/config/opencode']) assert.equal(fixture.nodes.get(file).mode, 0o700);
});

test('real symlink config is rejected without modifying its owned target', () => {
  const privateRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memocap-preload-symlink-'));
  const home = path.join(privateRoot, 'home');
  const target = path.join(privateRoot, 'foreign');
  const config = path.join(privateRoot, 'config');
  try {
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, config);
    const { prepareOwnedPreload } = require('./preload-preparation.cjs');
    assert.throws(() => prepareOwnedPreload(privateRoot, { home, config }), { code: 'preload_owned_layout_required' });
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(target), []);
  } finally {
    fs.rmSync(privateRoot, { recursive: true });
  }
});

test('owned filesystem driver observes W_OK refusal and removes only its fresh fixture', () => {
  const parent = fs.realpathSync(os.tmpdir());
  const privateRoot = fs.mkdtempSync(path.join(parent, 'memocap-preload-offline-'));
  const paths = { home: path.join(privateRoot, 'home'), config: path.join(privateRoot, 'config') };
  let prepared;
  try {
    fs.mkdirSync(paths.home, { mode: 0o700 });
    fs.mkdirSync(paths.config, { mode: 0o700 });
    const { prepareOwnedPreload } = require('./preload-preparation.cjs');
    prepared = prepareOwnedPreload(privateRoot, paths);
    for (const directory of prepared.directories) {
      assert.throws(() => fs.accessSync(directory, fs.constants.W_OK), { code: 'EACCES' });
      assert.deepEqual(fs.readdirSync(directory).sort(), directory === paths.config ? ['.gitignore', 'opencode'] : ['.gitignore']);
    }
    assert.deepEqual(fs.readdirSync(paths.home), []);
  } finally {
    prepared?.restore();
    fs.rmSync(privateRoot, { recursive: true });
  }
  assert.equal(fs.existsSync(privateRoot), false);
});
