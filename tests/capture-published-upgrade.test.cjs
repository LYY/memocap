"use strict";
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { targetVersion, verifyPackage, retained, complete, nativeProof, setupProof, provisionHost } = require('./capture-published-upgrade/package.cjs');
const { verifyRead, verifyCapture, installedSDK } = require('./capture-published-upgrade/host.cjs');
const bytes = Buffer.from('independent published fixture bytes');
const dist = { tarball: 'https://registry.npmjs.org/@lyy-gh/memocap/-/memocap-0.7.0.tgz',
  integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` };
const packed = { name: '@lyy-gh/memocap', version: '0.7.0', integrity: dist.integrity };
const expected = { id: 41, placement: `repository:${'a'.repeat(64)}`, content: 'Synthetic durable preference',
  content_hash: 'f37e967591c48ffdc0667d352fe6e1e76a6b4d5aa9fa4f1e4bd2c9b90ce2e4d8', tags: 'capture-fixture' };
const read = () => ({ status: 'ok', returned_ids: [41], record_changed: false, results: [{ completeness: 'full',
  content_hash: expected.content_hash, memory: { ...expected } }] });
const database = () => ({ schema_version: '2.3', schema: [{ name: 'activity_events', sql: 'original DDL' }], tables: {
  memories: [{ id: 41, content: 'before', placement: expected.placement }], domains: [{ id: 'domain-a' }],
  memory_provenance: [{ memory_id: 41, source_id: 17 }], activity_events: [{ sequence: 3, event_json: 'original' }] } });
test('verified public bytes are accepted', () => assert.doesNotThrow(() => verifyPackage({ dist, packed, bytes }, '0.7.0')));
for (const change of [p => { p.packed.version = '0.6.0'; }, p => { p.packed.name = 'other'; },
  p => { p.dist.integrity = 'sha512-invalid'; }, p => { p.bytes = Buffer.from('corrupted'); },
  p => { p.dist.tarball = 'file:/local.tgz'; }]) test('untrusted package fails before host', () => {
  const value = { dist: { ...dist }, packed: { ...packed }, bytes };
  change(value);
  assert.throws(() => verifyPackage(value, '0.7.0'));
});
test('unpinned target is rejected', () => assert.throws(() => verifyPackage({ dist, packed, bytes }, 'latest')));
for (const table of ['memories', 'domains', 'memory_provenance', 'activity_events']) test(`changed ${table} fails retention`, () => {
  const after = database(); after.tables[table][0] = { altered: true };
  assert.throws(() => retained(database(), after));
});
test('activity DDL also must remain identical', () => {
  const after = database(); after.schema[0].sql = 'changed';
  assert.throws(() => retained(database(), after));
});
test('unchanged full snapshot passes', () => assert.doesNotThrow(() => retained(database(), database())));
for (const field of ['id', 'content', 'placement']) test(`retained memory ${field} cannot change`, () => {
  const after = database(); after.tables.memories[0][field] = 'changed';
  assert.throws(() => retained(database(), after));
});
for (const field of ['id', 'placement', 'content', 'tags']) test(`independent read rejects wrong ${field}`, () => {
  const receipt = read(); receipt.results[0].memory[field] = 'wrong';
  assert.throws(() => verifyRead(receipt, expected));
});
for (const change of [r => { r.results[0].completeness = 'partial'; }, r => { r.results[0].content_hash = 'wrong'; },
  r => { r.returned_ids = [99]; }, r => { r.status = 'unknown'; }]) test('incomplete or wrong read fails', () => {
  const receipt = read(); change(receipt); assert.throws(() => verifyRead(receipt, expected));
});
test('inserted without independent readback is not saved', () => {
  assert.throws(() => verifyCapture({ status: 'inserted', returned_ids: [41] }, expected));
});
for (const status of ['failed', 'unknown', 'outcome_unknown']) test(`${status} cannot pass acceptance`, () => {
  assert.throws(() => complete({ status, cleanup: { sandbox_removed: true, active_children: 0 } }));
});
test('cleanup failure cannot pass acceptance', () => assert.throws(() => complete({ status: 'passed',
  cleanup: { sandbox_removed: false, active_children: 1, host_port_closed: false, provider_port_closed: false } })));
for (const status of ['failed', 'outcome_unknown']) test(`setup step ${status} rejects even optimistic readiness`, () => {
  assert.throws(() => setupProof({ exit_code: 0, error: null, readiness: 'static_ready', steps: [{ status }] }));
});
test('full independent receipt passes and capture with readback is saved', () => {
  verifyRead(read(), expected);
  verifyCapture({ status: 'inserted', returned_ids: [41], readback: read() }, expected);
});
for (const field of ['id', 'placement', 'content_hash', 'completeness']) test(`project B automatic reference rejects wrong ${field}`, () => {
  const { assertLibraryReference } = require('./opencode-v1/discovery.cjs');
  const entry = { ...expected, completeness: 'full', applicability: 'unknown', applicable_repositories: [],
    read: { tool: 'memocap_read', arguments: { id: 41, placement: expected.placement, content_hash: expected.content_hash } } };
  const receipt = { status: 'ok', discovery: { kind: 'library' }, returned_ids: [41], references: [entry], truncated: false };
  assertLibraryReference(receipt, expected);
  entry[field] = 'wrong';
  assert.throws(() => assertLibraryReference(receipt, expected));
});
test('native bytes and checksum use the existing launcher verification seam', context => {
  const fs = require('node:fs'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'published-native-synthetic-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { binary: path.join(root, 'binary'), checksum: path.join(root, 'checksum'), name: 'binary' };
  fs.writeFileSync(files.binary, 'abc');
  fs.writeFileSync(files.checksum, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  binary\n');
  const launcher = require('../bin/cli.cjs');
  assert.equal(nativeProof(launcher, files), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  fs.writeFileSync(files.binary, 'tampered');
  assert.throws(() => nativeProof(launcher, files));
});
test('installed proof fetches the new release checksum after same-path replacement', async context => {
  const fs = require('node:fs'), path = require('node:path');
  const { installedProof } = require('./capture-published-upgrade/package.cjs');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'published replacement '));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installedRoot = path.join(root, 'installed');
  const env = { XDG_CACHE_HOME: path.join(root, 'cache'), LOCALAPPDATA: path.join(root, 'cache') };
  const cache = process.platform === 'darwin' ? path.join(root, 'Library/Caches') : env.XDG_CACHE_HOME;
  const { name } = require('../bin/cli.cjs').resolveReleaseAsset(process.platform, process.arch);
  const releases = new Map();
  for (const version of ['0.6.0', targetVersion]) {
    const payload = path.join(root, version);
    fs.mkdirSync(path.join(payload, 'bin'), { recursive: true });
    for (const file of ['cli.cjs', 'cache-lock.cjs']) {
      fs.copyFileSync(path.join(__dirname, '../bin', file), path.join(payload, 'bin', file));
    }
    fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ name: '@lyy-gh/memocap', version }));
    const binary = path.join(cache, 'memocap', version, name);
    const nativeBytes = Buffer.from(`synthetic native ${version}`);
    const checksum = `${crypto.createHash('sha256').update(nativeBytes).digest('hex')}  ${name}\n`;
    const url = `https://github.com/LYY/memocap/releases/download/v${version}/${name}.sha256`;
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, nativeBytes);
    fs.writeFileSync(`${binary}.sha256`, checksum);
    releases.set(url, checksum);
    fs.cpSync(payload, installedRoot, { recursive: true });

    const host = { version: '1.19.3' };
    const readiness = { observed: '2.3', status: 'ready' };
    const proof = await installedProof({ installedRoot, env, home: root, evidence: { baseline_host: host, host },
      async command(executable, args) {
        if (executable === 'memocap') return { stdout: `memocap ${version}\n` };
        assert.equal(executable, process.execPath);
        assert.equal(args[2], url);
        return { stdout: releases.get(args[2]) };
      },
      managed: () => ({ manifest: { format_version: 2 }, config_text: '// synthetic unmanaged comment',
        config: { permission: { custom_tool: { 'private/*': 'deny' } } } }),
      json: () => ({ runner_version: version, prerequisites: { opencode: host.version }, readiness: 'static_ready',
        shared_cli: { executable_version: version }, backend: { core_schema: readiness, activity: readiness } }),
      cli: () => ({ inspection: { schema_version: '2.3', core_status: 'ready', activity_status: 'ready' } }),
    }, { payload, version });
    assert.equal(proof.native.checksumURL, url);
  }
});
for (const opt of [undefined, '0']) test(`opt-out ${opt} skips before helper import or sandbox creation`, () => {
  const { spawnSync } = require('node:child_process');
  const entry = require.resolve('./capture-published-upgrade.integration.test.cjs');
  const script = `const Module=require('node:module');const load=Module._load;Module._load=function(id,...args){
    if(id.includes('capture-published-upgrade/')||id.includes('setup-package-lifecycle'))throw Error('helper imported');
    return load.call(this,id,...args)};require('node:fs').mkdtempSync=()=>{throw Error('sandbox created')};require(process.argv[1]);`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.MEMOCAP_CAPTURE_PUBLISHED_E2E;
  if (opt !== undefined) env.MEMOCAP_CAPTURE_PUBLISHED_E2E = opt;
  const result = spawnSync(process.execPath, ['-e', script, entry], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipped 3/);
});
test('no-init fixture isolates credentials, overrides and caches without native initialization', async () => {
  const { fixture } = require('./capture-published-upgrade/package.cjs');
  const evidence = { commands: [] };
  const sandbox = fixture(require('node:path').resolve(__dirname, '..'), evidence);
  try {
    assert.equal(sandbox.env.npm_config_registry, 'https://registry.npmjs.org');
    for (const key of ['MEMOCAP_BINARY', 'MEMOCAP_TEST_NATIVE', 'MEMOCAP_TEST_TARBALL', 'npm_config_prefer_offline', 'NPM_TOKEN', 'OPENAI_API_KEY'])
      assert.equal(sandbox.env[key], undefined, key);
    assert.ok(sandbox.env.npm_config_cache.startsWith(sandbox.root));
    assert.equal(require('node:fs').existsSync(sandbox.env.MEMOCAP_DB), false);
    assert.deepEqual(evidence.commands, []);
  } finally { assert.equal((await sandbox.cleanup()).sandbox_removed, true); }
});
test('public verification rejects corrupt wire bytes before extraction or installation', async context => {
  const fs = require('node:fs'), path = require('node:path');
  const { publicPackage } = require('./capture-published-upgrade/package.cjs');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'published-wire-synthetic-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wire = { root, evidence: {}, json: async (_binary, args) => {
    if (args[0] === 'view') return dist;
    fs.writeFileSync(path.join(root, 'public-0.7.0/bad.tgz'), 'corrupt');
    return [{ ...packed, filename: 'bad.tgz' }];
  }, command: async () => { throw Error('extractor reached before integrity verification'); } };
  await assert.rejects(publicPackage(wire, '0.7.0'), { code: 'ERR_ASSERTION' });
});
test('provisionHost verifies the installed OpenCode v1 and its executable', async context => {
  const fs = require('node:fs'), path = require('node:path');
  const platformPackage = { 'darwin-arm64': 'opencode-darwin-arm64', 'linux-x64': 'opencode-linux-x64',
    'win32-x64': 'opencode-windows-x64' }[`${process.platform}-${process.arch}`];
  if (!platformPackage) return context.skip('no official host fixture for this platform');
  for (const { label, phase, version, reported, error } of [
    { label: 'pins the published 0.6 baseline to its compatible host', phase: 'baseline', version: '1.19.3', reported: '1.19.3' },
    { label: 'rejects newer v1 in the legacy baseline phase', phase: 'baseline', version: '1.25.4', reported: '1.25.4',
      error: { code: 'ERR_ASSERTION', actual: '1.25.4', expected: '1.19.3' } },
    { label: 'pins the target fixture to the observed host', version: '1.19.6', reported: '1.19.6' },
    { label: 'rejects a different installed v1 host in the target fixture', version: '1.25.4', reported: '1.25.4',
      error: { code: 'ERR_ASSERTION', actual: '1.25.4', expected: '1.19.6' } },
    { label: 'rejects a mismatched executable', version: '1.19.6', reported: '1.19.3',
      error: { code: 'ERR_ASSERTION', actual: '1.19.3', expected: '1.19.6' } },
    { label: 'rejects an installed v2 even if the executable matches', version: '2.0.0', reported: '2.0.0',
      error: /installed OpenCode package must be v1/ },
  ]) {
    await context.test(label, async subtest => {
      const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'published host bootstrap '));
      subtest.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const tools = path.join(root, 'tools');
      const modules = path.join(tools, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules');
      const installed = path.join(modules, 'opencode-ai');
      const host = path.join(installed, 'node_modules', platformPackage, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
      const binary = Buffer.from('synthetic OpenCode executable');
      const evidence = {};
      const installs = [];
      const sandbox = { root, evidence, async command(executable, args) {
        if (executable === 'npm') {
          installs.push(args);
          fs.mkdirSync(path.dirname(host), { recursive: true });
          fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'opencode-ai', version }));
          fs.writeFileSync(host, binary);
          return { stdout: '' };
        }
        assert.equal(executable, host);
        assert.deepEqual(args, ['--version']);
        return { stdout: `${reported}\n` };
      } };

      if (error) {
        await assert.rejects(provisionHost(sandbox, phase), error);
        assert.equal(evidence.host, undefined);
        assert.equal(evidence.baseline_host, undefined);
      } else {
        assert.equal(await provisionHost(sandbox, phase), host);
        const key = phase === 'baseline' ? 'baseline_host' : 'host';
        assert.deepEqual(evidence[key], { version, sha256: crypto.createHash('sha256').update(binary).digest('hex'),
          origin: 'official_public_package' });
      }
      assert.deepEqual(installs, [['install', '--global', '--prefix', tools,
        phase === 'baseline' ? 'opencode-ai@1.19.3' : 'opencode-ai@1.19.6', '--registry', 'https://registry.npmjs.org']]);
    });
  }
});
test('installed SDK import follows nested and hoisted import-only dependencies in paths with spaces', async context => {
  const fs = require('node:fs'), path = require('node:path');
  const { runner } = require('./packaged-runtime.cjs');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'published sdk resolution '));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const active = new Set(), evidence = { commands: [] };
  const command = runner({}, evidence, active, root);
  for (const layout of ['nested', 'hoisted', 'wrong-version', 'missing']) {
    await context.test(layout, async () => {
      const modules = path.join(root, layout, 'prefix with spaces/lib/node_modules');
      const installedRoot = path.join(modules, '@lyy-gh/memocap');
      fs.mkdirSync(installedRoot, { recursive: true });
      fs.writeFileSync(path.join(installedRoot, 'package.json'), JSON.stringify({ name: '@lyy-gh/memocap', version: '0.7.0' }));
      if (layout !== 'missing') {
        const sdkRoot = path.join(layout === 'nested' ? path.join(installedRoot, 'node_modules') : modules, '@opencode-ai/sdk');
        fs.mkdirSync(path.join(sdkRoot, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(sdkRoot, 'package.json'), JSON.stringify({ name: '@opencode-ai/sdk',
          version: layout === 'wrong-version' ? '1.19.2' : '1.19.3', type: 'module',
          exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } } }));
        fs.writeFileSync(path.join(sdkRoot, 'dist/index.js'),
          `export const createOpencodeClient = () => (${JSON.stringify({ layout, marker: 'synthetic-offline' })});`);
      }
      if (layout === 'missing') await assert.rejects(installedSDK({ installedRoot, command }));
      else if (layout === 'wrong-version') await assert.rejects(installedSDK({ installedRoot, command }), { code: 'ERR_ASSERTION' });
      else {
        const sdk = await installedSDK({ installedRoot, command });
        assert.deepEqual(sdk.createOpencodeClient(), { layout, marker: 'synthetic-offline' });
      }
      assert.equal(active.size, 0);
    });
  }
});
