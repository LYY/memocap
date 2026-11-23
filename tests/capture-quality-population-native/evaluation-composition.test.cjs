const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createEvaluation, population } = require('./population.cjs');
const { toy } = require('./evaluation-fixture.cjs');
const { hash } = require('./value.cjs');
const { caseLimits } = require('./inventory.cjs');

test('concrete composition serializes the selected descriptor and per-case reservation before any listener', async () => {
  const evaluation = createEvaluation(toy()); const filename = path.join(__dirname, 'concrete-host.cjs');
  const local = createRequire(filename); const module = { exports: {} }; let config; let reservation;
  const paths = Object.fromEntries(['settings', 'database', 'socket', 'home', 'config', 'data', 'cache', 'state', 'tmp', 'project']
    .map((name) => [name, `/toy/run/${name}`]));
  const deps = { 'node:fs': { writeFileSync(_file, bytes) { config = JSON.parse(bytes); } },
    'node:http': { createServer() { throw new Error('inert_listener_boundary'); } },
    './authorization.cjs': { assertAuthorization() {}, sources: () => ({ digest: 'inert-source' }) },
    './owned.cjs': { owned: () => ({ paths, preparation: {}, materialize() {} }) }, './startup.cjs': { recheckStartup() {} },
    './control.cjs': { control: () => ({ bind() {}, bindProvider(value) { reservation = value.limits; } }) } };
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', '__dirname'], { filename })(
    (name) => deps[name] ?? local(name), module, __dirname);
  const binding = { synthetic: true }; const approval = { network_binding: binding, evaluation_sha256: hash(evaluation) };
  const host = module.exports.concreteHost({ evaluation, network_binding: binding, profile: {}, endpoints: [],
    paths: { case_roots: ['/toy/run'] }, node: { path: '/toy/node' }, native: { path: '/toy/native' } }, approval, 'toy-update', 0);
  await assert.rejects(host.open({ charge() {} }), /inert_listener_boundary/);
  assert.deepEqual(config.plugin[0][1].evaluation, evaluation);
  assert.equal(config.plugin[0][1].evaluation_sha256, hash(evaluation));
  assert.equal(config.permission['*'], 'ask');
  assert.deepEqual(reservation, caseLimits('toy-update', population(evaluation)));
});

test('plugin config uses the selected toy authorization without passing the descriptor to production hooks', async () => {
  const { createOpencodeClient } = await import('@opencode-ai/sdk');
  const client = createOpencodeClient({ baseUrl: 'http://inert.invalid', fetch: async () => assert.fail('unexpected SDK transport') });
  const { install } = require('./plugin-runtime.cjs'); const evaluation = createEvaluation(toy());
  const origin = `repository:${'b'.repeat(64)}`; const seeded = []; let delivered;
  const hooks = await install({ client, serverUrl: new URL('http://inert.invalid'), directory: '/toy/project' }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: require('./authorization.cjs').sources().digest,
    approval_id: 'toy', socket: '/toy/socket', token: 'toy', privateRoot: '/toy', paths: { database: '/toy/db' },
    case: 'toy-update', evaluation, evaluation_sha256: hash(evaluation), endpoints: [],
  }, { rpc: async () => assert.fail('unexpected control dispatch'), fetch: async () => assert.fail('unexpected transport'),
    native: { invoke: async () => assert.fail('unexpected native invocation'), initialize: async () => origin,
      seed: async (request) => { seeded.push(request); return { ...request, id: 71, readback: { ...request, id: 71 } }; } },
    fixture: async (input) => { delivered = input; return {}; } });
  const config = { provider: { 'openai-b1': { options: {} } } };
  await hooks.config(config);
  assert.deepEqual(seeded, [{ content: 'Toy primary.', placement: origin }]);
  assert.equal(config.permission['*'], 'ask');
  assert.equal(Object.keys(config.permission.memocap_maintain).length, 1);
  assert.equal(Object.hasOwn(delivered, 'evaluation'), false);
});
