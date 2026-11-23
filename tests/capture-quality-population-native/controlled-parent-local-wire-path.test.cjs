const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileFunction } = require('node:vm');
const { test } = require('node:test');

for (const scenario of ['negative', 'recall', 'invalid']) test(`wire ${scenario} checks source authority without forcing adoption`, async () => {
  const wire = require('./curator-fixture-wire.cjs');
  const permissions = require('./permission-configuration.cjs');
  const native = await wire.wireNative({ paths: { project: '/synthetic/project', database: '/synthetic/db' } }, () => {});
  const setup = await permissions.preparePermissions(wire.scenarios[scenario], native, '/synthetic/db');
  const prepared = await wire.wirePacket(scenario, { session: 'root', operation: { tool: 'read', input: { filePath: '/synthetic/project/source' } },
    async call(method, request) { return method === 'initialize' ? { origin: setup.origin } : setup.seed(request); } });
  const configured = await permissions.fixturePermissions(wire.scenarios[scenario], { root: '/synthetic/project', worktree: '/synthetic', origin: setup.origin, database: '/synthetic/db' }, prepared.seeds);

  await wire.verifyPermissions(scenario, { configured, rules: configured.root(prepared.packet), database: '/synthetic/db', seeds: prepared.seeds });

  const refused = () => assert.fail('wire_bind_effect');
  const parent = require('./controlled-parent.cjs').controlledParent({ charge: refused, flush: refused, endpoints: [] });
  parent.bind(prepared.packet);

  assert.equal(parent.root(), 'root');
  assert.deepEqual(parent.packet().memories.filter((memory) => memory.declaration).map(({ id }) => id),
    scenario === 'negative' ? [prepared.seeds[0].id] : []);
  assert.equal(prepared.packet.review, false);
  assert.equal(prepared.packet.memories[0].access, scenario === 'negative' ? 'read' : 'recall');
});

test('public secret mode accepts the real screened result without opening or delivering to a host', async () => {
  const filename = path.join(__dirname, 'controlled-parent-local-wire-qa.cjs');
  const reportFile = path.resolve(__dirname, '../../.omo/evidence/capture-expansion/controlled-parent-local-wire-actual-secret-probe.json');
  const reports = new Map();
  const refused = () => assert.fail('secret_runtime_effect');
  const bindings = {
    'node:path': path, 'node:assert/strict': assert,
    'node:fs': { writeFileSync(file, bytes) { assert.equal(file, reportFile); reports.set(file, JSON.parse(bytes)); } },
    'node:crypto': require('node:crypto'), 'node:url': require('node:url'), 'node:events': require('node:events'),
    'node:http': { createServer: refused }, 'node:net': { createServer: refused },
    'node:child_process': { spawn: refused }, './process.cjs': { launch: refused }, './control.cjs': { control: refused },
    './owned.cjs': { owned: refused }, './authorization.cjs': { sources: refused },
    './permission-configuration.cjs': { fixturePermissions: refused, validateInstancePath: refused },
    './sdk-boundary.cjs': { boundSDK: refused }, '../opencode-v1/host.cjs': { portClosed: refused },
    './cleanup.cjs': { cleanupOwned: async () => ({ exited: true }) },
    './adapter.cjs': require('./adapter.cjs'), './curator-fixture-wire.cjs': require('./curator-fixture-wire.cjs'),
  };
  const moduleRecord = { exports: {} };
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', '__filename', '__dirname', 'AbortSignal'], { filename })(
    (name) => { assert.ok(Object.hasOwn(bindings, name), name); return bindings[name]; }, moduleRecord, filename, __dirname,
    { timeout: () => new AbortController().signal });

  const result = await moduleRecord.exports.main(['--run-fixture-wire', 'secret', reportFile]);

  assert.equal(result.actual_execution, 'PASS_WHOLE_SECRET_PREFLIGHT_ONLY');
  const report = reports.get(reportFile);
  assert.equal(report.screen.status, 'wired');
  assert.deepEqual(report.screen.budget_used, {});
  assert.deepEqual(report.screen.custody, []);
  assert.deepEqual(report.screen.completion_evidence, []);
  assert.equal(report.screen.trace, null);
  assert.equal(report.screen.transport, null);
  assert.deepEqual(report.owned, { pids: [], ports: [] });
});

test('public run canonicalizes the approved aliased parent before the owned allocation boundary', async () => {
  const filename = path.join(__dirname, 'controlled-parent-local-wire-qa.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const parent = '/var/folders/x_/n5qr2_211jg2j9_7q_gdxw940000gn/T/opencode';
  const physical = `/private${parent}`;
  const uuid = '00000000-0000-4000-8000-000000000001';
  const expected = path.join(physical, `controlled-wire-${uuid}`);
  const reportFile = path.resolve(__dirname, '../../.omo/evidence/capture-expansion/controlled-parent-local-wire-actual-alias-probe.json');
  const node = '/opt/homebrew/Cellar/node/26.13.0_2/bin/node';
  const hashes = new Map([
    [node, '3b78c226730ec2d7b65704113f63ce3c04a8168cdf990390ec3adfc0a356d87f'],
    ['/opt/homebrew/bin/opencode', 'feaafead8cd563af0c2dcb386b0757e4355e327ebb6bd1aaad5440fe2f83596c'],
  ]);
  const trace = []; const reports = new Map(); let allocated;
  const refused = () => assert.fail('effect beyond owned boundary');
  const fakeFS = {
    readFileSync(file) { assert.ok(hashes.has(file)); return hashes.get(file); },
    realpathSync(directory) { assert.equal(directory, parent); trace.push('realpath'); return physical; },
    writeFileSync(file, bytes, options) {
      assert.equal(file, reportFile);
      if (options?.flag === 'wx') assert.equal(reports.has(file), false);
      reports.set(file, JSON.parse(bytes));
    },
  };
  const bindings = {
    'node:fs': fakeFS, 'node:path': path, 'node:assert/strict': assert,
    'node:crypto': { randomUUID: () => uuid,
      createHash: () => ({ update: (bytes) => ({ digest: () => bytes }) }) },
    'node:url': require('node:url'), 'node:events': require('node:events'),
    'node:http': { createServer: refused }, 'node:net': { createServer: refused },
    'node:child_process': { spawn: refused }, './process.cjs': { launch: refused },
    './control.cjs': { control: refused },
    './owned.cjs': { owned(directory) {
      allocated = directory; trace.push('owned');
      throw Object.assign(new Error('inert stop at owned boundary'), { code: 'INERT_OWNED_BOUNDARY' });
    } },
    './cleanup.cjs': { cleanupOwned: async () => ({ exited: true }) },
    './authorization.cjs': { sources: () => ({ digest: 'd'.repeat(64) }) },
    './permission-configuration.cjs': { fixturePermissions: refused, validateInstancePath: refused },
    './sdk-boundary.cjs': { boundSDK: refused }, '../opencode-v1/host.cjs': { portClosed: refused },
  };
  const localRequire = (name) => { assert.ok(Object.hasOwn(bindings, name), name); return bindings[name]; };
  const moduleRecord = { exports: {} };
  compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname', 'process', 'AbortSignal', 'clearTimeout'], { filename })(
    moduleRecord.exports, localRequire, moduleRecord, filename, __dirname, { execPath: node },
    { timeout: () => new AbortController().signal }, () => {});

  const result = await moduleRecord.exports.main(['--run-local-wire', reportFile]);

  assert.equal(allocated, expected);
  assert.deepEqual(trace, ['realpath', 'owned']);
  assert.equal(reports.get(reportFile).journal.find((row) => row.kind === 'reserve_private_root').privateRoot, expected);
  assert.equal(reports.get(reportFile).failure.code, 'INERT_OWNED_BOUNDARY');
  assert.equal(result.actual_execution, 'UNPROVEN');
});
