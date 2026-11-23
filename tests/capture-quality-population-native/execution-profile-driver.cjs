const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { mock } = require('node:test');
const { createCapture } = require('../../plugin/capture/index.js');

async function runProfiles() {
  const results = [];
  for (const captureExecutionMs of [30000, 45000, 60000]) {
    let now = 100;
    const events = []; const entered = Promise.withResolvers(); const release = Promise.withResolvers();
    const waiting = Promise.withResolvers(); const coordinator = Promise.withResolvers();
    const done = Promise.withResolvers(); let recordings = 0; let hooks;
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
    mock.method(performance, 'now', () => now);
    const advance = (milliseconds) => { now += milliseconds; mock.timers.tick(milliseconds); };
    try {
      hooks = createCapture({ client: {
        session: { get(request) {
          if (!request.signal) return Promise.resolve({ data: { directory: '/synthetic/project' } });
          entered.resolve(request.signal); return release.promise;
        } }, tool: { ids: async () => ({ data: [] }) }, _client: { get: async () => ({ data: {} }) },
      }, captureExecutionMs, captureCoordinator: { owns: () => false, beforeReview() { waiting.resolve(); return coordinator.promise; } },
      captureObservation: { onTimer: (event) => events.push(event), onReview: done.resolve } },
      { warnings: [], context: async () => ({}), request: async () => { recordings++; return {}; } }, {});
      hooks.observe({ sessionID: 'root' }, { message: { id: 'user', role: 'user' },
        parts: [{ id: 'text', type: 'text', text: 'Check the synthetic route.' }] });
      hooks.event({ event: { type: 'message.updated', properties: { info: { id: 'assistant', sessionID: 'root', role: 'assistant',
        parentID: 'user', finish: 'stop', time: { created: 1, completed: 2 } } } } });
      hooks.event({ event: { type: 'session.status', properties: { sessionID: 'root', status: { type: 'idle' } } } });
      await waiting.promise; advance(40000); coordinator.resolve(true);
      const signal = await Promise.race([entered.promise, done.promise.then((summary) => { throw new Error(JSON.stringify(summary)); })]);
      advance(captureExecutionMs - 1); const before = signal.aborted;
      advance(1); const at = signal.aborted;
      release.resolve({ data: { parentID: 'inert-foreign-parent' } });
      const summary = await done.promise;
      await hooks.dispose(); hooks = undefined;
      const count = events.length; advance(120001);
      const armed = events.find(({ phase }) => phase === 'execution.armed');
      const fired = events.find(({ phase }) => phase === 'execution.fired');
      assert.equal(before, false); assert.equal(at, true);
      assert.equal(fired.monotonic_ms - armed.monotonic_ms, captureExecutionMs);
      assert.equal(summary.reason, 'capture_timeout'); assert.equal(summary.write_attempts, 0);
      assert.equal(summary.timing.execution_elapsed_ms, captureExecutionMs);
      assert.equal(summary.timing.coordinator_elapsed_ms, 40000);
      assert.equal(summary.timing.review_elapsed_ms, captureExecutionMs + 40000);
      assert.equal(events.length, count);
      results.push({ captureExecutionMs, observed_timer_ms: fired.monotonic_ms - armed.monotonic_ms,
        aborted_before: before, aborted_at: at, summary, fake_activity_recordings: recordings,
        cleanup: { disposed: true, post_dispose_events: events.length - count }, network_requests: 0, native_processes: 0 });
    } finally { coordinator.resolve(false); release.resolve({ data: {} }); await hooks?.dispose(); mock.timers.reset(); mock.restoreAll(); }
  }
  return results;
}
if (require.main === module) runProfiles().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
  console.error(error); process.exitCode = 1;
});
module.exports = { runProfiles };
