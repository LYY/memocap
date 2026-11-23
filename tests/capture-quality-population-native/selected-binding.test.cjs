const assert = require('node:assert/strict');
const test = require('node:test');
const { authorize } = require('./authorization.cjs');
const { selection, endpoint } = require('./selected-provider-fixture.cjs');
const grant = { kind: 'quality-full-population-native-v1', approved: true,
  authorization: 'new-explicit-user-grant', mode: 'native', approval_id: 'offline-selection-only' };
for (const [name, mutate] of [
  ['missing', () => undefined], ['changed_address', (binding) => ({ ...binding, address: '198.18.5.41' })],
  ['extra_endpoint', (binding) => ({ ...binding, endpoint: `${endpoint}/extra` })],
  ['numeric_hostname', (binding) => ({ ...binding, hostname: binding.address })],
  ['ipv6', (binding) => ({ ...binding, address: '::1', family: 6 })],
  ['stale', (binding) => ({ ...binding, selection: { ...binding.selection, selected_at: '2020-01-01T00:00:00Z' } })],
  ['future', (binding) => ({ ...binding, selection: { ...binding.selection, selected_at: '2099-01-01T00:00:00Z' } })],
  ['missing_resolution', (binding) => ({ ...binding, selection: { ...binding.selection, resolution_sha256: null } })],
  ['canary', (binding) => ({ ...binding, selection: { ...binding.selection, approval_id: 'old-canary' } })],
]) test(`authorize rejects ${name} binding before filesystem or runtime input access`, () => {
  const binding = selection(); const changed = mutate(binding);
  const input = new Proxy({ network_binding: changed, endpoints: [endpoint] }, { get(target, key) {
    if (key in target) return target[key]; throw new Error('later_input_access');
  } });
  assert.throws(() => authorize(input, { ...grant, network_binding: binding }), { code: 'selected_provider_binding' });
});
test('fresh selected tuple is validated without resolving or authorizing its address', () => {
  const { validateSelection } = require('./selected-binding.cjs');
  const binding = selection();
  assert.doesNotThrow(() => validateSelection(binding, [endpoint], grant.approval_id));
  assert.throws(() => validateSelection(binding, [endpoint, 'https://foreign.invalid'], grant.approval_id), /selected_provider_binding/);
});
test('native plugin refuses missing selected binding even with an injected JSON control RPC', async () => {
  const { install } = require('./plugin-runtime.cjs'); const { sources } = require('./authorization.cjs');
  await assert.rejects(install({ serverUrl: new URL('http://127.0.0.1:4444') }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: sources().digest, approval_id: 'offline-only',
    socket: '/synthetic/socket', token: 'token', privateRoot: '/synthetic', paths: { database: '/synthetic/db' },
    endpoints: [endpoint], case: 'queued-exit-zero',
  }, { rpc: async () => { throw new Error('rpc_must_not_run'); }, native: { invoke() {} } }), /selected_provider_binding/);
});
test('injected offline fetch cannot make a malformed binding an actual child bridge', async () => {
  const { install } = require('./plugin-runtime.cjs'); const { sources } = require('./authorization.cjs');
  await assert.rejects(install({ serverUrl: new URL('http://127.0.0.1:4444') }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: sources().digest, approval_id: 'offline-selection-only',
    socket: '/synthetic/socket', token: 'token', privateRoot: '/synthetic', paths: { database: '/synthetic/db' },
    endpoints: [endpoint], case: 'queued-exit-zero', network_binding: { ...selection(), address: '::1', family: 6 },
  }, { fetch: async () => { throw new Error('fetch_must_not_run'); },
    fixture: async () => { throw new Error('fixture_must_not_run'); }, native: { invoke() {} } }), /selected_provider_binding/);
});
