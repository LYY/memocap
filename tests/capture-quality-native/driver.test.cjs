const assert = require('node:assert/strict');
const test = require('node:test');
const { main } = require('./driver.cjs');
const { diagnostics } = require('./diagnostics.cjs');

test('public prepare command reports carrier mapping and all blocked support slots without execution', async () => {
  const report = await main(['--prepare']);
  assert.equal(report.status, 'offline_prepared_runtime_blocked');
  assert.equal(report.execution.provider_dispatches, 0);
  assert.equal(report.support.length, 8);
  assert.ok(report.support.every((slot) => slot.status === 'seam_not_reached'));
  assert.equal(report.holdout, 'not_accessed');
});

test('public driver refuses enable without a new model-only profile declaration', async () => {
  assert.equal((await main(['--enable'])).reason, 'model_only_profile_required');
});

test('malformed CLI flags never echo potentially secret argument values', async () => {
  const report = await main(['--secret=SECRET']);
  assert.equal(report.status, 'blocked');
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
});

test('origin metadata emits categories and identity equality without source strings', () => {
  const report = diagnostics({ status: 200, result: { data: { plugin_origins: [
    { spec: ['file:///task/plugin.js', {}], scope: 'local', source: 'OPENCODE_CONFIG_CONTENT' },
    { spec: 'https://secret.invalid/KEY', scope: 'global', source: '/private/SECRET' },
  ], mcp: {} } } }, ['file:///task/plugin.js']);
  assert.equal(report.origins.entries[0].task_owned, true);
  assert.equal(report.origins.entries[0].source_category, 'task_config_content');
  assert.equal(report.origins.entries[1].source_category, 'other_or_unknown');
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
});

test('MCP status is unavailable until its separate native response is observed', () => {
  const report = diagnostics({ status: 200, result: { data: { plugin_origins: [], mcp: {} } } }, []);
  assert.equal(report.mcp.status_presence, 'unavailable');
  assert.equal(report.isolation, 'unknown');
});
