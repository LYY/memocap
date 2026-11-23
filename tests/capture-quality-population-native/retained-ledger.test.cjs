const assert = require('node:assert/strict');
const test = require('node:test');
const { inventory } = require('./inventory.cjs');
const profile = 'controlled_native_parent_genuine_curator_v1';

test('public runtime retains caller measured parent and worker charges with bounded local counters', async () => {
  const fs = require('node:fs'); const vm = require('node:vm'); const path = require('node:path');
  const { createRequire } = require('node:module'); const filename = path.join(__dirname, 'runtime.cjs'); const local = createRequire(filename);
  const module = { exports: {} }; let attempts = 0; let opens = 0;
  const meter = require('./inventory.cjs').createMeter({ mode: 'offline' }, 'offline');
  const prior = { requests: 147, parent_requests: 95, worker_requests: 52, provider_requests: 147,
    provider_request_bytes: 2017330, provider_response_bytes: 7186598 };
  const approval = { limits: inventory().limits, retained_ledger_sha256: require('./value.cjs').hash(prior) };
  const deps = { 'node:fs': { writeFileSync(_file, _body, options) { assert.equal(options.flag, 'wx'); attempts++; },
    mkdirSync() {}, readdirSync: () => ['retained'], rmdirSync() {} },
    './authorization.cjs': { authorize: () => approval, sources: () => ({ digest: 'inert' }) },
    './concrete-host.cjs': { concreteHost(settings) { assert.equal(settings.execution_profile, profile); opens++; return {}; } },
    './inventory.cjs': { inventory, createMeter: () => meter },
    './adapter.cjs': { async runCase(id, { meter }) {
      meter.charge('scripted_root_generations'); meter.charge('scripted_root_dispatches');
      return { id, cleanup: { exited: true, children: 0, removed: true, control_stopped: true, listener_closed: true } };
    } } };
  const requireFake = (name) => deps[name] ?? local(name); requireFake.main = null;
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(requireFake, module, module.exports);
  assert.equal(typeof module.exports[profile], 'function', 'fixed prospective profile must be executable');
  const result = await module.exports[profile]({ paths: { attempt: '/inert/attempt', privateRoot: '/inert/private' } }, approval, prior);
  assert.equal(attempts, 1); assert.equal(opens, 28); assert.equal(result.execution_profile, profile);
  assert.deepEqual(result.budget_prior_used, prior);
  assert.equal(result.budget_cumulative_used.requests, 147); assert.equal(result.budget_cumulative_used.parent_requests, 95);
  assert.equal(result.budget_used.scripted_root_generations, 28); assert.equal(result.historical_worker_measurement.direct, 52);
  assert.equal(result.historical_worker_measurement.derived, 52);
  await assert.rejects(module.exports.runNative({ execution_profile: profile, paths: { attempt: '/inert/reset', privateRoot: '/inert/reset-root' } }, {}, {}), /controlled_prior_spend/);
});
