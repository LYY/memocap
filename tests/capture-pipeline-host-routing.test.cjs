const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const lifecycle = require('./setup-package-lifecycle-fixture.cjs');

test('explicit capture host prepares the package without installing a packaged host', async (t) => {
  const prepared = new Error('stop after checking the package bootstrap');
  const env = process.env;
  t.after(() => { process.env = env; });
  process.env = { ...env, MEMOCAP_CAPTURE_HOST_EXECUTABLE: '/selected/opencode',
    MEMOCAP_CAPTURE_HOST_EXPECTED_VERSION: '1.19.6', MEMOCAP_CAPTURE_PACKAGED_HOST: '0' };
  t.mock.method(fs, 'rmSync', () => {});
  t.mock.method(lifecycle, 'lifecycleFixture', () => ({
    env: {},
    async prepare({ installPackagedHost = true } = {}) {
      assert.equal(installPackagedHost, false, 'explicit host must not trigger historical installation');
      throw prepared;
    },
    async cleanup() {},
  }));
  const { harness } = require('./capture-pipeline-host/harness.cjs');

  await assert.rejects(harness({ cleanup: {} }, '/unused/scratch'), (error) => error === prepared);
});
