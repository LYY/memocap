const assert = require('node:assert/strict');
const { runNative, fixtures } = require('./controller.cjs');
const { invokeNative } = require('./native-proxy.cjs');
const { joinReadRoute } = require('./projection.cjs');
const { CanaryBlocked } = require('./entry.cjs');
const { memoryIO } = require('./fakes.cjs');
const { memoryReceipt, successfulResult } = require('./receipt-fakes.cjs');
const { joined } = require('./join-fakes.cjs');
const { fakePreparation } = require('./preload-decision.test-support.cjs');

async function driveController(scenario) {
  const io = memoryIO();
  let writes = 0;
  let sequence = 0;
  let turns = 0;
  const input = { enabled: true, profileRef: '/fake-profile', credentialRef: 'fake-native-reference',
    consent: 'quality-native-canary-v1:fresh-bounded-runtime', providerDestinations: ['https://provider.invalid/responses'],
    authDestinations: [], existingCapability: true, approvalRef: '/fake-approval', attemptFile: '/fake-attempt', privateRoot: '/fake-owned' };
  const result = await runNative(input, { io, fixtures: () => fixtures(), preparePreload: fakePreparation,
    approve: () => ({ batch: 'fake-only', fingerprint: 'fake-only', native: { path: '/fake-native' }, model: {} }),
    startHost: async ({ pure, budget }) => {
      budget.host(pure ? 'pure' : 'nonpure');
      if (scenario === (pure ? 'pure-exit-unknown' : 'nonpure-exit-unknown')) throw new CanaryBlocked('cleanup_exit_unknown');
      const session = { create: async () => ({ data: { id: `session-${++sequence}` } }), abort: async () => ({}),
        prompt: async (request) => {
          const id = request.path.id;
          const user = `user-${++turns}`;
          const extract = `extract-${turns}`;
          const active = budget.snapshot().active;
          budget.root(id, user, active?.slot); budget.child(extract, id, 'extract');
          if (active?.challenge) {
            budget.support(extract); budget.dispatch(extract, 'provider');
            budget.event({ kind: 'candidate.injected', slot: active.slot });
          }
          if (!active?.slot) {
            if (scenario === 'reserve-only') budget.write(extract);
            budget.child('session-1-commit', id, 'commit');
            invokeNative(['--caller-json', JSON.stringify(memoryReceipt().caller), 'remember', 'offline synthetic content'],
            { nativeBinary: '/fake-native', root: '/fake-root' }, { budget, execute: () => {
              writes++;
              if (scenario === 'denial-then-unknown') { budget.stop('permission_denied'); return { signal: 'SIGTERM' }; }
              const value = scenario === 'empty-json' ? {} : memoryReceipt();
              if (scenario === 'invalid-projection') value.results[0].memory.content = null;
              return successfulResult(value);
            } });
          }
          budget.event({ kind: 'capture.terminal', session: id, user, status: 'skipped' });
          return { data: { info: { finish: 'stop' } } };
        }, messages: async () => scenario === 'history-failed' ? { error: true } : { data: [] } };
      return { client: { session }, close: async () => {} };
    },
    invokeNative: () => successfulResult(memoryReceipt('read')),
  });
  return { scenario, removed: result.cleanup.private_root_removed, retained: io.existsSync(input.privateRoot),
    recovery: result.cleanup.readback_recovery_required === true, terminal: result.budget.terminal,
    dispatched_writes: writes, journal_attempts: result.budget.write_attempts.length };
}

async function main() {
  const controllers = [];
  for (const scenario of ['pure-exit-unknown', 'nonpure-exit-unknown', 'empty-json', 'invalid-projection',
    'denial-then-unknown', 'history-failed', 'reserve-only', 'good-cleanup']) {
    const result = await driveController(scenario);
    const safe = ['reserve-only', 'good-cleanup'].includes(scenario);
    assert.equal(result.removed, safe); assert.equal(result.retained, !safe);
    assert.equal(result.dispatched_writes, scenario.endsWith('exit-unknown') || scenario === 'reserve-only' ? 0 : 1);
    if (['empty-json', 'invalid-projection', 'denial-then-unknown', 'history-failed'].includes(scenario)) assert.equal(result.recovery, true);
    if (scenario === 'denial-then-unknown') assert.equal(result.terminal, 'permission_denied');
    controllers.push(result);
  }
  const joins = [];
  for (const [scenario, mutate] of [
    ['good-join', () => {}], ['wrong-tool', (fake) => { fake.events[6].tool = 'other'; }],
    ['wrong-packet-user', (fake) => { fake.events[0].packet.current_user_id = 'other'; }],
    ['wrong-packet-child', (fake) => { fake.events[0].session = 'other'; }],
    ['wrong-native-record', (fake) => { fake.events[3].receipt.records[0].id = 99; }],
    ['failed-readback', (fake) => { fake.events[4].receipt.status = 'failed'; }],
  ]) {
    const fake = joined(); mutate(fake);
    const result = joinReadRoute(fake);
    assert.equal(result.status, scenario === 'good-join' ? 'native_join_verified_adjudication_pending' : 'seam_not_reached');
    assert.equal(result.quality_credit, false);
    joins.push({ scenario, status: result.status, quality_credit: result.quality_credit });
  }
  return { evidence: 'offline_in_memory_only', controllers, joins, actual_native_runtimes: 0, actual_databases: 0 };
}

if (require.main === module) main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => { process.stderr.write(`${error instanceof Error ? error.name : 'Error'}\n`); process.exitCode = 1; });
module.exports = { main, driveController };
