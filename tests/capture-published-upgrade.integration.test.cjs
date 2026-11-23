"use strict";
const test = require('node:test');
const enabled = process.env.MEMOCAP_CAPTURE_PUBLISHED_E2E === '1';
for (const [lane, predecessor] of [['fresh', null], ['upgrade', '0.6.0'], ['upgrade-from-0.7.0', '0.7.0']]) test(`published QA8 ${lane}`, { skip: !enabled, timeout: 600000 }, async () => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { targetVersion, fixture, publicPackage, installedProof, retained, seed, complete, provisionHost, setupProof } = require('./capture-published-upgrade/package.cjs');
  const { runtime } = require('./capture-published-upgrade/host.cjs');
  const { snapshot, digest } = require('./packaged-runtime.cjs');
  const { retain, observe } = require('./opencode-v1/phases.cjs');
  const workspace = path.resolve(__dirname, '..');
  const destination = process.env.MEMOCAP_CAPTURE_PUBLISHED_EVIDENCE;
  assert.ok(destination && path.isAbsolute(destination), 'explicit absolute evidence directory required');
  const release = path.join(workspace, `.omo/evidence/capture-expansion/release-v${targetVersion}.json`);
  const releaseBytes = fs.readFileSync(release);
  const receipt = JSON.parse(releaseBytes);
  const evidence = { status: 'running', lane, predecessor, target_version: targetVersion, commands: [], cleanup: {}, public_run: 'running',
    release_evidence: { path: release, sha256: digest(releaseBytes) },
    platform: { platform: process.platform, arch: process.arch, node: process.version },
    claims: { genuine_model_calls: 0, scripted_host_proof: true, model_quality: 'not_evaluated', other_platforms: 'not_run' } };
  const sandbox = fixture(workspace, evidence);
  const filename = path.join(destination, `v${targetVersion}`, `${lane}.json`);
  let failure;
  try {
    evidence.initial_cache = snapshot([path.join(sandbox.home, 'Library/Caches/memocap'),
      path.join(sandbox.env.XDG_CACHE_HOME, 'memocap'), path.join(sandbox.env.LOCALAPPDATA, 'memocap')]);
    assert.deepEqual(evidence.initial_cache, {});
    const target = await observe(evidence, 'target_public_bytes', () => publicPackage(sandbox, targetVersion, receipt));
    const legacyHost = predecessor === '0.6.0';
    let host = legacyHost ? await observe(evidence, 'official_baseline_host', () => provisionHost(sandbox, 'baseline'))
      : await observe(evidence, 'official_host', () => provisionHost(sandbox));
    const initial = predecessor ? await publicPackage(sandbox, predecessor) : target;
    const install = await observe(evidence, 'install', () => sandbox.setup(initial.version, ['install', '--yes']));
    setupProof(install);
    evidence.install = install;
    evidence.initial = await installedProof(sandbox, initial);
    if (predecessor) {
      await seed(sandbox);
      const before = sandbox.database(), managed = await sandbox.managed();
      evidence.before = { database: before, managed };
      assert.equal(before.schema_version, '2.3');
      for (const table of ['memories', 'domains', 'repository_domain_attachments', 'memory_provenance', 'operation_ledger', 'activity_events'])
        assert.ok(before.tables[table].length > 0, table);
      if (legacyHost) host = await observe(evidence, 'official_host', () => provisionHost(sandbox));
      const roots = [sandbox.config, path.join(sandbox.env.XDG_STATE_HOME, 'memocap/setup.json'), managed.policy.directory, sandbox.prefix];
      const bytes = snapshot(roots);
      evidence.preflight = [];
      const targetSetup = async (args, installedVersion) => {
        const report = await sandbox.setup(target.version, [...args, '--to', target.version]);
        assert.equal(report.runner_version, target.version);
        assert.equal(report.resolved_version, target.version);
        assert.equal(report.prerequisites.opencode, evidence.host.version);
        assert.equal(report.shared_cli.manager, 'npm');
        assert.equal(report.shared_cli.version, installedVersion);
        assert.deepEqual(report.scopes.map(({ kind, config }) => ({ kind, config })), [{ kind: 'global', config: sandbox.config }]);
        return report;
      };
      for (const { args, status } of [{ args: ['check'], status: 'ok' }, { args: ['update', '--dry-run'], status: 'planned' }]) {
        const report = await targetSetup(args, initial.version);
        evidence.preflight.push(report);
        assert.equal(report.status, status);
        assert.equal(report.error, null);
        retained(before, sandbox.database());
        assert.deepEqual(await sandbox.managed(), managed);
        assert.deepEqual(snapshot(roots), bytes);
      }
      evidence.update = await targetSetup(['update', '--yes'], target.version);
      setupProof(evidence.update);
      evidence.static = await installedProof(sandbox, target);
      evidence.after = { database: sandbox.database(), managed: await sandbox.managed() };
      retained(before, evidence.after.database);
      assert.equal(evidence.static.managed.config.theme, managed.config.theme);
    } else evidence.static = evidence.initial;
    const business = sandbox.database();
    await observe(evidence, 'managed_real_host_capture_and_recall', () => runtime({ ...sandbox, host }, evidence.static));
    const afterRuntime = sandbox.database();
    for (const [table, rows] of Object.entries(business.tables)) {
      if (table === 'activity_events' || table.startsWith('memories_fts') || table === 'sqlite_sequence') continue;
      for (const row of rows) assert.ok(afterRuntime.tables[table].some(value => JSON.stringify(value) === JSON.stringify(row)), table);
    }
    evidence.after_runtime = afterRuntime;
    evidence.status = 'passed'; evidence.public_run = 'passed';
  } catch (error) {
    failure = error; evidence.status = 'failed'; evidence.public_run = 'failed';
    evidence.error = { message: error.message, stack: error.stack };
    evidence.recovery = { sandbox: sandbox.root, retained: true, replay_authorized: false };
  } finally {
    if (!failure) {
      try { Object.assign(evidence.cleanup, await sandbox.cleanup()); complete(evidence); }
      catch (error) { failure = error; evidence.status = 'failed'; evidence.public_run = 'failed'; evidence.cleanup.error = error.message; }
    }
    retain(filename, evidence, []);
  }
  if (failure) throw failure;
});
