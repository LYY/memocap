const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalFixture } = require('./execution-terminal-fixture.cjs');
const { createEvaluation } = require('./population.cjs');
const { toy } = require('./evaluation-fixture.cjs');
const { captureExecutionProfile } = require('../../plugin/capture/execution-profile.js');

for (const maintenanceExecutionMs of [45000, 60000]) test(`candidate${maintenanceExecutionMs} ready bind wait and terminal retain one selected profile without native effects`, async (context) => {
  const current = await terminalFixture(45000, false, maintenanceExecutionMs);
  context.after(current.dispose);
  await current.call('bind', { root: 'root', review: false, captureExecutionMs: 45000, maintenanceExecutionMs });
  const result = await current.call('wait', { review: false, captureExecutionMs: 45000, maintenanceExecutionMs });
  assert.equal(current.ready[0].maintenanceExecutionMs, maintenanceExecutionMs);
  assert.deepEqual(result.capture_execution_profile, captureExecutionProfile(45000, maintenanceExecutionMs));
});

for (const method of ['bind', 'wait']) for (const maintenanceExecutionMs of [undefined, 30000, null, '45000', 60000, 61000]) {
  test(`candidate ${method} refuses ${maintenanceExecutionMs} before binding or readback`, async (context) => {
    const current = await terminalFixture(45000, false, 45000);
    context.after(current.dispose);
    await assert.rejects(current.call(method, { root: 'root', review: false, captureExecutionMs: 45000, maintenanceExecutionMs }),
      { code: [null, '45000', 61000].includes(maintenanceExecutionMs) ? 'maintenance_execution_profile' : 'capture_execution_profile_mismatch' });
  });
}

for (const maintenanceExecutionMs of [45000, 60000]) test(`candidate${maintenanceExecutionMs} terminal cannot collect a maintenance30 profile`, async (context) => {
  const current = await terminalFixture(45000, false, maintenanceExecutionMs);
  context.after(current.dispose);
  assert.throws(() => current.emit({ parentID: 'root', user_id: 'user', workflow: 'maintenance',
    execution_profile: captureExecutionProfile(45000) }), { code: 'capture_execution_profile_mismatch' });
});

test('candidate descriptor mismatch is rejected before native factory key or helper access', async () => {
  const { install } = require('./plugin-runtime.cjs');
  await assert.rejects(install({}, { kind: 'quality-full-population-plugin-v1',
    source_sha256: require('./authorization.cjs').sources().digest,
    approval_id: 'injected-only', socket: '/synthetic/socket', token: 'injected-only', privateRoot: '/synthetic', paths: { database: '/synthetic/db' },
    evaluation: createEvaluation({ ...toy(), maintenanceExecutionMs: 45000 }), maintenanceExecutionMs: 30000,
    get case() { return assert.fail('case lookup preceded profile rejection'); } }, {
    get native() { return assert.fail('native factory reached'); }, get fetch() { return assert.fail('provider reached'); },
  }), { code: 'capture_execution_profile_mismatch' });
});
