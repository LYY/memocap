const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { finalize, selector } = require('./capture-final-safety/combined-fixture.cjs');

const selectorFile = 'tests/capture-final-safety-host.integration.test.cjs';

function fixture(context, { closeError, leftover = false, maintenanceCloseGate } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'final-safety-fixture-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const captureResource = path.join(directory, 'capture');
  const maintenanceResource = path.join(directory, 'maintenance');
  fs.writeFileSync(captureResource, 'open');
  fs.writeFileSync(maintenanceResource, 'open');
  const evidence = {
    status: 'observed', safety_observations: [], cleanup: {},
    cases: [{ case_id: 'recursion', attempts: [{}, {}] }],
    capture_checked: { comparisons: 3 }, maintenance_checked: { comparisons: 5 },
    source: { sha256: 'fixture-source' }, selector_file: selectorFile,
    lane: 'native_real_host_challenges', host: { pid: 101, version: 'fixture', sha256: 'fixture-host' },
    native: { sha256: 'fixture-native' }, maintenance: { host: { pid: 102 }, cleanup: {} },
  };
  const current = { async close() {
    fs.unlinkSync(captureResource);
    Object.assign(evidence.cleanup, { host_port_closed: true, provider_port_closed: true, control_port_closed: true,
      package: { active_children: 0, registry_closed: true, sandbox_removed: true }, scratch_dependency_link_removed: true });
  } };
  const maintenance = { control: { events: [] }, provider: { requests: [] }, async close() {
    if (maintenanceCloseGate) await maintenanceCloseGate;
    if (closeError) throw closeError;
    if (!leftover) fs.unlinkSync(maintenanceResource);
    Object.assign(evidence.maintenance.cleanup, { host_port_closed: true, provider_port_closed: true,
      control_port_closed: true, sandbox_removed: !leftover });
  } };
  const artifact = path.join(directory, 'observations.json');
  return { artifact, captureResource, maintenanceResource,
    run: (failure) => finalize(context, { directory, evidence, current, maintenance, failure }),
    read: () => JSON.parse(fs.readFileSync(artifact, 'utf8')) };
}

function expectPassed(persisted, cleanupStatus) {
  assert.equal(persisted.status, 'passed');
  const selectorDigest = createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', selectorFile))).digest('hex');
  assert.deepEqual(persisted.safety_observations, [['recursion', 2], ['activity_leak', 8]].map(([clause, denominator]) => ({
    clause, lane: 'native_real_host_challenges', selector: `${selectorFile}::${selector}`, source_sha256: 'fixture-source',
    selector_sha256: selectorDigest, host_version: 'fixture', host_sha256: 'fixture-host', native_sha256: 'fixture-native',
    denominator, violations: 0, result: 'satisfied',
  })));
  assert.equal(persisted.cleanup.status, cleanupStatus);
  assert.equal(persisted.cleanup.process_enumeration, 'not_attempted');
  assert.equal(Object.hasOwn(persisted.cleanup, 'remaining_owned_processes'), false);
}

test.beforeEach((context) => {
  const spawn = context.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stderr: '', stdout: '999 0 synthetic\n' }));
  context.after(() => assert.equal(spawn.mock.callCount(), 0, 'the finalizer must not spawn any process'));
});

test('combined final safety fixture: clean success and exclusive evidence', async (context) => {
  const clean = fixture(context);
  await clean.run();
  expectPassed(clean.read(), 'clean');
  assert.deepEqual(clean.read().cleanup.errors, []);

  const collision = fixture(context, { closeError: new Error('synthetic maintenance close failure') });
  fs.writeFileSync(collision.artifact, 'existing evidence', { flag: 'wx' });
  await assert.rejects(collision.run(), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(collision.artifact, 'utf8'), 'existing evidence');
});

test('combined final safety fixture: close exception does not prevent a fresh isolated case', async (context) => {
  const closeError = new Error('synthetic maintenance close failure');
  const warning = fixture(context, { closeError });
  await warning.run();
  expectPassed(warning.read(), 'warning');
  assert.deepEqual(warning.read().cleanup.errors, [{ fixture: 'maintenance', error: closeError.stack }]);
  assert.equal(fs.existsSync(warning.captureResource), false);
  assert.equal(fs.existsSync(warning.maintenanceResource), true);

  const fresh = fixture(context);
  await fresh.run();
  expectPassed(fresh.read(), 'clean');
  assert.notEqual(fresh.artifact, warning.artifact);
  assert.equal(fs.existsSync(fresh.maintenanceResource), false);
  assert.equal(fs.existsSync(warning.maintenanceResource), true);
});

test('combined final safety fixture: reported leftover is diagnostic without a close exception', async (context) => {
  const warning = fixture(context, { leftover: true });
  await warning.run();
  const persisted = warning.read();
  expectPassed(persisted, 'warning');
  assert.deepEqual(persisted.cleanup.errors, []);
  assert.equal(persisted.maintenance.cleanup.sandbox_removed, false);
  assert.equal(fs.existsSync(warning.maintenanceResource), true);
});

test('combined final safety fixture: a hung close cannot block the next isolated case', { timeout: 2000 }, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = Promise.withResolvers();
  const hung = fixture(context, { maintenanceCloseGate: gate.promise });
  const pending = hung.run();

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(hung.captureResource), false, 'capture close must not wait for maintenance');
  assert.equal(fs.existsSync(hung.maintenanceResource), true);
  context.mock.timers.tick(39_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(hung.artifact), false, 'the unfinished close gets the whole cleanup budget');
  context.mock.timers.tick(1);
  await pending;

  const persisted = hung.read();
  expectPassed(persisted, 'warning');
  assert.deepEqual(persisted.cleanup.errors.map(({ fixture, error }) => [fixture, error.split('\n')[0]]),
    [['maintenance', 'Error: Fixture close did not settle within 40000 ms']]);
  const fresh = fixture(context);
  await fresh.run();
  expectPassed(fresh.read(), 'clean');
  assert.notEqual(fresh.artifact, hung.artifact);
  assert.equal(fs.existsSync(hung.maintenanceResource), true);

  gate.reject(new Error('synthetic late close rejection'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(hung.read(), persisted);
});

test('combined final safety fixture: original product assertion outranks cleanup failure', async (context) => {
  const closeError = new Error('synthetic maintenance close failure');
  const productFailure = new assert.AssertionError({ actual: 1, expected: 0, message: 'synthetic recursion write' });
  const failed = fixture(context, { closeError });
  await assert.rejects(failed.run(productFailure), (error) => error === productFailure);
  const persisted = failed.read();
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.error, productFailure.stack);
  assert.deepEqual(persisted.safety_observations, []);
  assert.deepEqual(persisted.cleanup.errors, [{ fixture: 'maintenance', error: closeError.stack }]);
  assert.equal(fs.existsSync(failed.captureResource), false);
});
