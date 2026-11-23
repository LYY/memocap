const assert = require('node:assert/strict');
const test = require('node:test');
const { entry } = require('./capture-quality-native/entry.cjs');

test('genuine native quality canary requires its own new profile, destinations and consent', {
  skip: process.env.MEMOCAP_CAPTURE_QUALITY_NATIVE_CANARY !== '1',
}, () => {
  const result = entry({ enabled: true });
  assert.fail(`Native canary blocked before side effects: ${result.reason}. Use the driver with independently reviewed fresh runtime approval.`);
});
