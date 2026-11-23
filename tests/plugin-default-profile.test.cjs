const assert = require('node:assert/strict');
const test = require('node:test');
const { driver } = require('./plugin-default-profile-driver.cjs');
const { productionProbe } = require('./capture-quality-population-native/production-probe.cjs');

for (const [name, options, captureMs, maintenanceMs] of [
  ['omitted options', {}, 60000, 60000],
  ['explicit undefined', { captureExecutionMs: undefined, maintenanceExecutionMs: undefined }, 60000, 60000],
  ['explicit baseline', { captureExecutionMs: 30000, maintenanceExecutionMs: 30000 }, 30000, 30000],
  ['capture30 override only', { captureExecutionMs: 30000 }, 30000, 60000],
  ['capture45 override only', { captureExecutionMs: 45000 }, 45000, 60000],
  ['capture60 override only', { captureExecutionMs: 60000 }, 60000, 60000],
  ['maintenance override only', { maintenanceExecutionMs: 30000 }, 60000, 30000],
  ['maintenance45 override only', { maintenanceExecutionMs: 45000 }, 60000, 45000],
  ['maintenance60 override only', { maintenanceExecutionMs: 60000 }, 60000, 60000],
]) test(`real plugin hooks select independent budgets when ${name}`, async (context) => {
  const result = await driver(context, options);

  assert.equal(result.capture.execution_profile.capture_ms, captureMs);
  assert.equal(result.maintenance.budgets.timeout_ms, maintenanceMs);
  assert.equal(result.maintenance.combined_with_capture.timeout_ms, captureMs + maintenanceMs);
  assert.equal(result.capture.execution_profile.provider_request_ms, 30000);
  assert.equal(result.maintenance.execution_profile.provider_request_ms, 30000);
  assert.deepEqual(result.timers.map((event) => event.phase), ['execution.armed', 'execution.fired']);
  assert.equal(result.capture.write_attempts, 0);
});

test('real plugin rejects invalid budget values before inspecting policy or host input', async () => {
  const probe = await productionProbe();
  const entry = await probe.load('../../plugin/index.js');
  let effects = 0;
  const input = new Proxy({}, { get() { effects++; throw new Error('host_input_forbidden'); } });
  for (const key of ['captureExecutionMs', 'maintenanceExecutionMs']) {
    for (const invalid of [null, '45000', false, 0, 45001, 61000, NaN, Infinity, {}, []]) {
      const options = { [key]: invalid, get skillDirectory() { effects++; throw new Error('policy_forbidden'); } };

      await assert.rejects(entry.namespace.default.server(input, options), {
        code: key === 'captureExecutionMs' ? 'capture_execution_profile' : 'maintenance_execution_profile',
      });

      assert.equal(effects, 0);
      assert.equal(probe.defaults.length, 0);
    }
  }
});
