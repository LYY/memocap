const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { performance } = require('node:perf_hooks');
const { driver } = require('../maintenance-observation-driver.cjs');
const { createCapture } = require('../../plugin/capture/index.js');

async function runMaintenanceProfile() {
  let now = 100;
  let capture;
  const timers = [];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const done = Promise.withResolvers();
  const advance = (milliseconds) => { now += milliseconds; mock.timers.tick(milliseconds); };
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  mock.method(performance, 'now', () => now);
  try {
    const result = await driver({ captureExecutionMs: 45000, maintenanceExecutionMs: 45000,
      decision: (decision) => ({ action: 'keep', target: decision.target }),
      observer(event) { if (event.phase === 'review.started') advance(20000); },
      onPrompt() { advance(20000); },
      async ready(maintenance) {
        capture = createCapture({ captureExecutionMs: 45000, maintenanceExecutionMs: 45000,
          captureCoordinator: maintenance.coordinator,
          captureObservation: { onTimer: (event) => timers.push(event), onReview: done.resolve },
          client: { session: { get(request) {
            if (!request.signal) return Promise.resolve({ data: { directory: '/synthetic' } });
            entered.resolve(request.signal); return release.promise;
          } }, tool: { ids: async () => ({ data: [] }) }, _client: { get: async () => ({ data: {} }) } } },
        { warnings: [], context: async () => ({}), request: async () => ({}) }, {});
        capture.observe({ sessionID: 'parent' }, { message: { id: 'user', role: 'user' },
          parts: [{ id: 'text', type: 'text', text: 'Check the synthetic route.' }] });
        capture.event({ event: { type: 'message.updated', properties: { info: { id: 'assistant', sessionID: 'parent',
          parentID: 'user', role: 'assistant', finish: 'stop', time: { created: 1, completed: 2 } } } } });
        capture.event({ event: { type: 'session.status', properties: { sessionID: 'parent', status: { type: 'idle' } } } });
        const signal = await Promise.race([entered.promise, done.promise.then((summary) => { throw new Error(JSON.stringify(summary)); })]);
        assert.equal(now, 40100);
        advance(44999); assert.equal(signal.aborted, false);
        advance(1); assert.equal(signal.aborted, true);
        release.resolve({ data: { parentID: 'foreign-parent' } });
        const summary = await done.promise;
        assert.equal(summary.reason, 'capture_timeout');
        assert.equal(summary.timing.coordinator_elapsed_ms, 40000);
        assert.equal(summary.timing.execution_elapsed_ms, 45000);
        await capture.dispose(); capture = undefined;
      } });
    assert.equal(result.summary.status, 'keep');
    assert.equal(result.summary.budgets.timeout_ms, 45000);
    assert.equal(result.captureAllowed, true);
    const armed = timers.find(({ phase }) => phase === 'execution.armed');
    const fired = timers.find(({ phase }) => phase === 'execution.fired');
    assert.equal(fired.monotonic_ms - armed.monotonic_ms, 45000);
    const count = timers.length;
    advance(120001);
    assert.equal(timers.length, count);
    const sharedStart = now;
    const shared = await driver({ captureExecutionMs: 45000, maintenanceExecutionMs: 45000, commit: true,
      onPrompt({ packet, signal }) {
        advance(packet.stage === 'extract' ? 23000 : packet.stage === 'support' ? 5000 : 17000);
        assert.equal(signal.aborted, packet.stage === 'commit');
      } });
    assert.equal(now - sharedStart, 45000);
    assert.equal(shared.summary.reason, 'maintenance_timeout');
    assert.equal(shared.summary.model_calls, 3);
    assert.equal(shared.writes.length, 0);
    assert.equal(shared.captureAllowed, false);
    return { surface: 'public createMaintenance coordinator + createCapture', capture_ms: 45000,
      maintenance_ms: 45000, maintenance_elapsed_ms: 40000, capture_elapsed_ms: 45000,
      capture_starts_after_maintenance: true, capture_allowed_after_valid_keep: result.captureAllowed,
      timers, maintenance_summary: result.summary, post_dispose_events: timers.length - count,
      shared_three_generation_window: { elapsed_ms: now - sharedStart, summary: shared.summary,
        scripted_stages: shared.requests.map((packet) => packet.stage), writes: shared.writes.length },
      genuine_generations: 0, native_processes: 0, network_requests: 0, database_writes: 0 };
  } finally { release.resolve({ data: {} }); await capture?.dispose(); mock.timers.reset(); mock.restoreAll(); }
}

module.exports = { runMaintenanceProfile };
if (require.main === module) runMaintenanceProfile().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
  console.error(error); process.exitCode = 1;
});
