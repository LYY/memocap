const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runNative, fixtures } = require('./controller.cjs');
const { CanaryBlocked } = require('./entry.cjs');
const { memoryIO } = require('./fakes.cjs');
const { invokeNative } = require('./native-proxy.cjs');
const { memoryReceipt, successfulResult } = require('./receipt-fakes.cjs');
const { fakePreparation } = require('./preload-decision.test-support.cjs');

const input = { enabled: true, profileRef: '/model-only', credentialRef: 'native-reference',
  consent: 'quality-native-canary-v1:fresh-bounded-runtime', providerDestinations: ['https://provider.invalid/responses'],
  authDestinations: [], existingCapability: true, approvalRef: '/approval', attemptFile: '/attempt', privateRoot: '/owned' };

function harness(failure, writes = false) {
  const io = memoryIO();
  const log = [];
  const tasks = [];
  const control = { writeResult: successfulResult(memoryReceipt()), readResult: successfulResult(memoryReceipt('read')) };
  let sequence = 0;
  const dependencies = { io, fixtures: () => fixtures(), preparePreload: fakePreparation,
    approve: () => ({ batch: 'offline-test', fingerprint: 'offline',
    native: { path: '/native-fake' }, model: { providerID: 'offline', modelID: 'fake' } }),
  startHost: async ({ pure, budget, ownership }) => {
    log.push(pure ? 'pure.open' : 'native.open');
    budget.host(pure ? 'pure' : 'nonpure');
    if (failure === (pure ? 'pure.open' : 'native.open')) {
      ownership.exited = true;
      throw new CanaryBlocked(failure);
    }
    const client = { session: {
      create: async () => ({ data: { id: `session-${++sequence}` } }),
      prompt: async (request) => {
        tasks.push(request.body);
        if (failure === 'completion') return { data: { info: { finish: 'length' } } };
        const id = request.path.id;
        const user = `user-${tasks.length}`;
        const extract = `${id}-${user}-extract`;
        budget.root(id, user, budget.snapshot().active?.slot ?? null);
        budget.child(extract, id, 'extract');
        if (budget.snapshot().active?.challenge) {
          const slot = budget.snapshot().active.slot;
          budget.support(extract); budget.dispatch(extract, 'provider');
          budget.event({ kind: 'candidate.injected', slot });
        } else if (writes && !budget.snapshot().active?.slot) {
          if (control.reserveOnly) budget.write(extract);
          budget.child(`${id}-commit`, id, 'commit');
          invokeNative(['--caller-json', JSON.stringify({ actor: 'plugin', session_id: `${id}-commit`,
            message_id: 'commit-user' }), 'remember', 'offline synthetic content'],
          { nativeBinary: '/native-fake', root: '/root' }, { budget, execute: () => {
            log.push('write.execute');
            if (control.deniedDuringWrite) budget.stop('permission_denied');
            return failure === 'write.unknown' ? { signal: 'SIGTERM' } : control.writeResult;
          } });
        }
        budget.event({ kind: 'capture.terminal', session: id, user, status: 'skipped' });
        return { data: { info: { finish: 'stop' } } };
      },
      messages: async () => failure === 'history' ? { error: true } : { data: [] },
      abort: async () => { log.push('child.abort'); return {}; },
    } };
    return { client, close: async () => {
      log.push(pure ? 'pure.close' : 'native.close');
      if (!pure && failure === 'cleanup') throw new CanaryBlocked('cleanup_exit_unknown');
    } };
  },
  invokeNative: (args) => { log.push('independent.read'); assert.equal(args[0], 'read'); return control.readResult; },
  };
  const remove = io.rmSync;
  io.rmSync = (...args) => { log.push('owned.remove'); remove(...args); };
  return { dependencies, io, log, tasks, control };
}

for (const [name, mutate] of [
  ['empty JSON object', (fake) => { fake.control.writeResult = successfulResult({}); }],
  ['invalid projected content', (fake) => { const value = memoryReceipt(); value.results[0].memory.content = null;
    fake.control.writeResult = successfulResult(value); }],
  ['failed exit with a success-shaped body', (fake) => { fake.control.writeResult.status = 1; }],
  ['failed write status', (fake) => { const value = memoryReceipt(); value.status = 'failed';
    fake.control.writeResult = successfulResult(value); }],
  ['unrelated native caller', (fake) => { const value = memoryReceipt(); value.caller.session_id = 'other-child';
    fake.control.writeResult = successfulResult(value); }],
  ['unrelated returned record', (fake) => { const value = memoryReceipt(); value.returned_ids = [9];
    fake.control.writeResult = successfulResult(value); }],
  ['earlier denial masking an unknown dispatch', (fake) => {
    fake.control.deniedDuringWrite = true; fake.control.writeResult = { signal: 'SIGTERM' };
  }],
  ['failed independent read', (fake) => { const value = memoryReceipt('read'); value.status = 'failed';
    fake.control.readResult = successfulResult(value); }],
  ['partial independent read', (fake) => { const value = memoryReceipt('read'); value.truncated = true;
    fake.control.readResult = successfulResult(value); }],
  ['unrelated read tags', (fake) => { const value = memoryReceipt('read'); value.results[0].memory.tags = 'other';
    fake.control.readResult = successfulResult(value); }],
]) {
  test(`NATIVE-VERIFY-002 preserves dispatched write data after ${name}`, async () => {
    const fake = harness(null, true);
    mutate(fake);
    const report = await runNative(input, fake.dependencies);
    assert.equal(report.cleanup.private_root_removed, false);
    assert.equal(report.cleanup.readback_recovery_required, true);
    assert.equal(fake.io.existsSync(input.privateRoot), true);
    assert.equal(fake.log.filter((item) => item === 'write.execute').length, 1);
  });
}

test('NATIVE-VERIFY-002 requires readback even after a resolved receipt when history fails', async () => {
  const fake = harness('history', true);
  const report = await runNative(input, fake.dependencies);
  assert.equal(report.cleanup.private_root_removed, false);
  assert.equal(report.cleanup.readback_recovery_required, true);
  assert.equal(fake.log.filter((item) => item === 'write.execute').length, 1);
  assert.equal(fake.log.includes('independent.read'), false);
});

test('NATIVE-VERIFY-002 a rejected reservation is not an actual dispatch', async () => {
  const fake = harness(null, true);
  fake.control.reserveOnly = true;
  const report = await runNative(input, fake.dependencies);
  assert.equal(report.reason, 'unexpected_write');
  assert.equal(report.cleanup.private_root_removed, true);
  assert.equal(fake.log.includes('write.execute'), false);
  assert.deepEqual(report.budget.write_attempts, []);
});

test('NATIVE-VERIFY-002 an independently matched full read resolves the actual write before cleanup', async () => {
  const fake = harness(null, true);
  const report = await runNative(input, fake.dependencies);
  assert.equal(report.cleanup.private_root_removed, true);
  assert.equal(Array.isArray(report.budget.write_attempts), true);
  assert.equal(report.budget.write_attempts.length, 1);
  assert.equal(report.budget.write_attempts[0].status, 'verified');
  assert.ok(fake.log.indexOf('independent.read') < fake.log.indexOf('owned.remove'));
});

test('conditional controller completes all deliverable fake branches and removes owned data after host exit', async () => {
  const fake = harness(null, true);
  const report = await runNative(input, fake.dependencies);
  assert.equal(report.status, 'executed_adjudication_pending');
  assert.equal(report.quality_pass, false);
  assert.equal(report.support.filter((slot) => slot.status === 'actual_support_observed_adjudication_pending').length, 7);
  assert.equal(report.support.filter((slot) => slot.status === 'seam_not_reached').length, 1);
  assert.equal(report.read_route.status, 'seam_not_reached');
  assert.equal(report.maintenance.status, 'seam_not_reached');
  assert.deepEqual(fake.log.slice(0, 3), ['pure.open', 'pure.close', 'native.open']);
  assert.ok(fake.log.indexOf('child.abort') < fake.log.indexOf('native.close'));
  assert.ok(fake.log.indexOf('native.close') < fake.log.indexOf('owned.remove'));
  assert.equal(fake.log.filter((item) => item === 'independent.read').length, 1);
  assert.equal(report.budget.writes, 1);
  assert.equal(fake.io.existsSync(input.attemptFile), true);
  assert.equal(fake.io.existsSync(input.privateRoot), false);
  for (const task of fake.tasks) assert.deepEqual(Object.keys(task).sort(), ['agent', 'model', 'parts']);
  await assert.rejects(() => runNative(input, fake.dependencies), { code: 'attempt_consumed' });
  assert.equal(fake.log.filter((item) => item.endsWith('.open')).length, 2);
});

test('unknown native write keeps private evidence for readback without replay or removal', async () => {
  const fake = harness('write.unknown', true);
  const report = await runNative(input, fake.dependencies);
  assert.equal(report.reason, 'native_write_unknown');
  assert.equal(report.budget.writes, 1);
  assert.equal(report.cleanup.private_root_removed, false);
  assert.equal(report.cleanup.readback_recovery_required, true);
  assert.equal(fake.io.existsSync(input.privateRoot), true);
  assert.equal(fake.log.includes('owned.remove'), false);
  assert.equal(fake.tasks.length, 1);
});

for (const failure of ['pure.open', 'native.open', 'completion', 'history', 'cleanup']) {
  test(`controller refuses further work and retains consumption after fake ${failure} failure`, async () => {
    const fake = harness(failure);
    const report = await runNative(input, fake.dependencies);
    assert.equal(report.status, 'blocked');
    assert.equal(fake.io.existsSync(input.attemptFile), true);
    assert.equal(report.cleanup.private_root_removed, failure !== 'cleanup');
    assert.equal(fake.tasks.length, ['completion', 'history'].includes(failure) ? 1 : failure === 'cleanup' ? 12 : 0);
    assert.equal(report.runtime_metrics, null);
  });
}

test('default and missing prerequisites never reach approval, directory creation or fake spawn', async () => {
  const fake = harness();
  fake.dependencies.approve = () => assert.fail('approval must not be read');
  assert.equal((await runNative({}, fake.dependencies)).status, 'not_run');
  assert.equal((await runNative({ enabled: true }, fake.dependencies)).reason, 'model_only_profile_required');
  assert.equal(fake.io.files.size, 0);
  assert.equal(fake.log.length, 0);
});

test('approval denial is terminal before consumption or any owned setup', async () => {
  const fake = harness();
  fake.dependencies.approve = () => { throw new CanaryBlocked('runtime_approval_mismatch'); };
  await assert.rejects(() => runNative(input, fake.dependencies), { code: 'runtime_approval_mismatch' });
  assert.equal(fake.io.files.size, 0);
  assert.equal(fake.log.length, 0);
});

test('setup cannot remove a pre-existing carrier directory it did not create', async () => {
  const fake = harness();
  fake.io.files.set(input.privateRoot, 'other-owner');
  fake.io.files.set(path.join(input.privateRoot, 'existing'), 'other-data');
  await runNative(input, fake.dependencies);
  assert.equal(fake.io.files.get(path.join(input.privateRoot, 'existing')), 'other-data');
  assert.equal(fake.log.includes('owned.remove'), false);
});

for (const phase of ['pure', 'nonpure']) {
  test(`NATIVE-VERIFY-001 retains owned data when ${phase} startup rejects before returning its handle`, async () => {
    const fake = harness();
    const open = fake.dependencies.startHost;
    fake.dependencies.startHost = async (options) => {
      if (options.pure === (phase === 'pure')) {
        options.budget.host(phase);
        throw new CanaryBlocked('cleanup_exit_unknown');
      }
      return open(options);
    };
    const report = await runNative(input, fake.dependencies);
    assert.equal(report.reason, 'cleanup_exit_unknown');
    assert.equal(report.cleanup.private_root_removed, false);
    assert.equal(fake.io.existsSync(input.privateRoot), true);
    assert.equal(fake.io.existsSync(input.attemptFile), true);
    assert.equal(fake.log.includes('owned.remove'), false);
  });
}
