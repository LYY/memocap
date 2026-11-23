const assert = require('node:assert/strict');
const test = require('node:test');
const { boundSDK } = require('./sdk-boundary.cjs');
const { createMeter } = require('./inventory.cjs');
const { offline } = require('./scenarios.cjs');

test('SDK request ceiling prevents another underlying request before dispatch', async () => {
  const meter = createMeter(offline, 'offline'); let calls = 0;
  const client = boundSDK({ session: { get: async () => { calls++; return { data: {} }; } } }, meter.charge);
  meter.charge('sdk_requests', meter.limits.sdk_requests);
  await assert.rejects(client.session.get({ path: { id: 'synthetic' } }), /budget_sdk_requests/);
  assert.equal(calls, 0);
});

test('oversize SDK request never reaches the supplied transport', async () => {
  let calls = 0;
  const client = boundSDK({ session: { get: async () => { calls++; } } }, () => {});
  await assert.rejects(client.session.get({ text: 'x'.repeat(65536) }), /sdk_request_bytes/);
  assert.equal(calls, 0);
});

test('oversize response stays blocked and is never silently truncated', async () => {
  const client = boundSDK({ session: { get: async () => ({ data: 'x'.repeat(131072) }) } }, () => {});
  await assert.rejects(client.session.get({}), /sdk_response_bytes/);
});
