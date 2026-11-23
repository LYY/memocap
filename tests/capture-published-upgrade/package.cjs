"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isolatedEnvironment, digest, snapshot } = require('../packaged-runtime.cjs');
const { lifecycleFixture } = require('../setup-package-lifecycle-fixture.cjs');
const { databaseSnapshot, managedSnapshot, assertRetained } = require('../setup-v050-upgrade/snapshots.cjs');
const registry = 'https://registry.npmjs.org';
function verifyPackage(value, version) {
  assert.ok(['0.6.0', '0.7.0'].includes(version));
  assert.equal(value.packed.name, '@lyy-gh/memocap');
  assert.equal(value.packed.version, version);
  assert.equal(new URL(value.dist.tarball).origin, registry);
  const actual = `sha512-${crypto.createHash('sha512').update(value.bytes).digest('base64')}`;
  assert.equal(value.dist.integrity, actual);
  assert.equal(value.packed.integrity, actual);
}
function retained(before, after) {
  assert.equal(after.schema_version, before.schema_version);
  assertRetained(before, after);
  assert.deepEqual(after.schema, before.schema, 'all schema including activity DDL retained');
}
function complete(evidence) {
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.cleanup.sandbox_removed, true);
  assert.equal(evidence.cleanup.active_children, 0);
  assert.equal(evidence.cleanup.host_port_closed, true);
  assert.equal(evidence.cleanup.provider_port_closed, true);
  assert.equal(evidence.cleanup.dispose_error, undefined);
}
function setupProof(report) {
  assert.equal(report.exit_code, 0); assert.equal(report.error, null);
  assert.equal(report.readiness, 'static_ready');
  for (const step of report.steps) assert.ok(['changed', 'unchanged', 'not_run'].includes(step.status), step.status);
}
function fixture(workspace, evidence) {
  const packaged = lifecycleFixture(workspace, evidence);
  const clean = isolatedEnvironment(packaged.root);
  clean.PATH = packaged.env.PATH;
  if (packaged.env.NODE_OPTIONS) clean.NODE_OPTIONS = packaged.env.NODE_OPTIONS;
  for (const key of Object.keys(packaged.env)) delete packaged.env[key];
  Object.assign(packaged.env, clean, { npm_config_registry: registry });
  const config = path.join(clean.XDG_CONFIG_HOME, 'opencode/opencode.jsonc');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, `// synthetic unmanaged comment\n${JSON.stringify({ theme: 'system',
    permission: { custom_tool: { 'private/*': 'deny' } } })}`);
  const directories = Object.fromEntries(['outside', 'A', 'B'].map(name => [name, path.join(packaged.root, name)]));
  for (const directory of Object.values(directories)) fs.mkdirSync(directory);
  const json = async (binary, args) => JSON.parse((await packaged.command(binary, args)).stdout);
  const npx = args => packaged.command(process.execPath, [path.join(path.dirname(packaged.npmCli), 'npx-cli.js'), ...args]);
  return Object.assign(packaged, { config, directories, json, evidence,
    cli: args => json('memocap', ['--json', ...args]),
    setup: async (version, args) => JSON.parse((await npx(['--yes', '--package', `@lyy-gh/memocap@${version}`,
      'memocap-setup', ...args, '--global', '--json'])).stdout),
    database: () => {
      const result = databaseSnapshot(packaged.env.MEMOCAP_DB);
      const database = new (require('node:sqlite').DatabaseSync)(packaged.env.MEMOCAP_DB, { readOnly: true });
      try { result.tables.schema_metadata = database.prepare('SELECT * FROM schema_metadata ORDER BY singleton').all().map(row => ({ ...row })); }
      finally { database.close(); }
      return result;
    },
    managed: () => managedSnapshot(packaged, config) });
}
async function publicPackage(fixture, version) {
  assert.ok(['0.6.0', '0.7.0'].includes(version));
  const spec = `@lyy-gh/memocap@${version}`;
  const dist = await fixture.json('npm', ['view', spec, 'dist', '--json', '--registry', registry]);
  const directory = path.join(fixture.root, `public-${version}`);
  fs.mkdirSync(directory);
  const packed = (await fixture.json('npm', ['pack', spec, '--json', '--ignore-scripts', '--registry', registry,
    '--pack-destination', directory]))[0];
  const tarball = path.join(directory, packed.filename);
  const bytes = fs.readFileSync(tarball);
  verifyPackage({ dist, packed, bytes }, version);
  await fixture.command('tar', ['-xzf', tarball, '-C', directory]);
  const payload = path.join(directory, 'package');
  const metadata = JSON.parse(fs.readFileSync(path.join(payload, 'package.json')));
  assert.equal(metadata.version, version); assert.equal(metadata.name, '@lyy-gh/memocap');
  const proof = { version, dist, packed, sha512: dist.integrity, sha256: digest(bytes), payload };
  fixture.evidence.artifacts ||= [];
  fixture.evidence.artifacts.push(proof);
  return proof;
}
async function installedProof(fixture, artifact) {
  const files = root => Object.fromEntries(Object.entries(snapshot([root])).filter(([,hash]) => hash !== 'directory')
    .map(([filename, hash]) => [path.relative(root, filename), hash]));
  const published = files(artifact.payload), installed = files(fixture.installedRoot);
  for (const [file, hash] of Object.entries(published)) assert.equal(installed[file], hash, file);
  const launcherPath = path.join(fixture.installedRoot, 'bin/cli.cjs');
  delete require.cache[require.resolve(launcherPath)];
  const launcher = require(launcherPath);
  const asset = launcher.resolveReleaseAsset(process.platform, process.arch);
  assert.ok(asset);
  const base = process.platform === 'darwin' ? path.join(fixture.home, 'Library/Caches') :
    process.platform === 'win32' ? fixture.env.LOCALAPPDATA : fixture.env.XDG_CACHE_HOME;
  const binary = path.join(base, 'memocap', artifact.version, asset.name);
  const checksum = `${binary}.sha256`;
  nativeProof(launcher, { binary, checksum, name: asset.name });
  const checksumURL = asset.checksumUrl;
  const remote = await fixture.command(process.execPath, ['-e',
    'fetch(process.argv[1],{signal:AbortSignal.timeout(25000)}).then(async r=>{if(!r.ok)throw Error(String(r.status));process.stdout.write(await r.text())})', checksumURL]);
  assert.equal(remote.stdout, fs.readFileSync(checksum, 'utf8'));
  const version = (await fixture.command('memocap', ['--version'])).stdout.trim();
  assert.equal(version, `memocap ${artifact.version}`);
  const managed = await fixture.managed();
  const doctor = await fixture.json('memocap-setup', ['doctor', '--global', '--json']);
  assert.equal(doctor.runner_version, artifact.version);
  assert.equal(doctor.prerequisites.opencode, (artifact.version === '0.6.0' ? fixture.evidence.baseline_host : fixture.evidence.host).version);
  assert.equal(doctor.readiness, 'static_ready'); assert.equal(doctor.shared_cli.executable_version, artifact.version);
  assert.equal(doctor.backend.core_schema.observed, '2.3'); assert.equal(doctor.backend.activity.status, 'ready');
  assert.equal(managed.manifest.format_version, 2);
  assert.ok(managed.config_text.includes('// synthetic unmanaged comment'));
  assert.deepEqual(managed.config.permission.custom_tool, { 'private/*': 'deny' });
  const status = await fixture.cli(['status', '--read-only']);
  assert.equal(status.inspection.schema_version, '2.3'); assert.equal(status.inspection.core_status, 'ready');
  assert.equal(status.inspection.activity_status, 'ready');
  return { files: published, native: { ...asset, checksumURL, sha256: digest(fs.readFileSync(binary)), version,
    platform: process.platform, arch: process.arch }, managed, doctor, status };
}
function nativeProof(launcher, files) {
  assert.equal(launcher.verifyCachedBinary(files.binary, files.checksum, files.name), true, 'public native checksum must verify');
  return digest(fs.readFileSync(files.binary));
}
async function seed(fixture) {
  const repo = fixture.directories.A, domain = 'published-synthetic-domain';
  await fixture.cli(['scope', 'domain', 'create', domain, '--repo', repo]);
  await fixture.cli(['scope', 'domain', 'attach', domain, '--repo', repo]);
  const receipts = [];
  for (const target of [[], ['--domain', domain], ['--universal']]) {
    receipts.push(await fixture.cli(['remember', `Synthetic QA8 baseline ${target.join(' ') || 'repository'}`,
      '--repo', repo, '--force', ...target]));
  }
  const id = receipts[0].returned_ids[0];
  const origin = receipts[0].results[0].memory.placement;
  receipts.push(await fixture.cli(['scope', 'copy', '--id', String(id), '--from', origin, '--to', 'universal',
    '--repo', repo, '--operation-id', crypto.randomUUID(), '--note', 'Synthetic QA8 provenance']));
  receipts.push(await fixture.cli(['recall', 'Synthetic QA8', '--library', '--repo', repo]));
  fixture.evidence.seed = receipts;
}
async function provisionHost(fixture, phase = 'target') {
  // The published v0.6.0 runner has a minor-version allowlist; the target does not.
  const baseline = phase === 'baseline';
  const requested = baseline ? '1.19.3' : '1';
  await fixture.command('npm', ['install', '--global', '--prefix', path.join(fixture.root, 'tools'),
    `opencode-ai@${requested}`, '--registry', registry], { env: { MEMOCAP_LINK_PHASE: 'official-host-bootstrap' } });
  const modules = path.join(fixture.root, 'tools', process.platform === 'win32' ? 'node_modules' : 'lib/node_modules');
  const platform = { 'darwin-arm64': 'opencode-darwin-arm64', 'linux-x64': 'opencode-linux-x64',
    'win32-x64': 'opencode-windows-x64' }[`${process.platform}-${process.arch}`];
  assert.ok(platform, 'only the three official supported targets are accepted');
  const installed = path.join(modules, 'opencode-ai');
  const { version } = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  const { isSupportedHost } = await import('../../lib/opencode-host.js');
  if (baseline) assert.equal(version, requested);
  else assert.ok(isSupportedHost(version), 'installed OpenCode package must be v1');
  const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const choices = [path.join(installed, 'node_modules', platform, 'bin', name), path.join(modules, platform, 'bin', name)];
  const host = choices.find(filename => fs.existsSync(filename));
  assert.ok(host);
  assert.equal((await fixture.command(host, ['--version'])).stdout.trim(), version);
  fixture.evidence[baseline ? 'baseline_host' : 'host'] = { version, sha256: digest(fs.readFileSync(host)), origin: 'official_public_package' };
  return host;
}
module.exports = { registry, verifyPackage, retained, complete, fixture, publicPackage, installedProof, seed, provisionHost, nativeProof, setupProof };
