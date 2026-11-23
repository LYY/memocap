const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { fixture, user } = require('./plugin-fixture.cjs');
const { productionProbe } = require('./capture-quality-population-native/production-probe.cjs');

async function driver(context, options = {}) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const probe = await productionProbe({ systemRoot: process.platform === 'win32' ? process.env.SystemRoot : undefined });
  const entry = await probe.load('../../plugin/index.js');
  const host = fixture();
  const bridge = await probe.load('../../plugin/bridge.js');
  bridge.setExport('run', host.run);
  const maintenanceStarted = Promise.withResolvers();
  const releaseMaintenance = Promise.withResolvers();
  const captureStarted = Promise.withResolvers();
  const releaseCapture = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const events = [];
  const hooks = await entry.namespace.default.server(host.input, {
    ...options,
    maintenanceObservation: async (event) => {
      events.push(event);
      if (event.phase === 'review.started') {
        maintenanceStarted.resolve(event);
        await releaseMaintenance.promise;
      }
    },
    captureObservation: {
      onTimer: (event) => events.push(event),
      onLifecycle: async (event) => {
        if (event.phase === 'review.started') {
          captureStarted.resolve();
          await releaseCapture.promise;
        }
      },
      onReview: finished.resolve,
    },
  });
  context.after(() => hooks.dispose());
  const message = user();
  await hooks['chat.message']({ sessionID: 'A', agent: 'build' }, { message: message.info, parts: message.parts });
  hooks.event({ event: { type: 'message.updated', properties: { info: {
    id: 'assistant', sessionID: 'A', parentID: message.info.id, role: 'assistant', finish: 'stop', time: { completed: 42 },
  } } } });
  hooks.event({ event: { type: 'session.status', properties: { sessionID: 'A', status: { type: 'idle' } } } });
  const maintenance = await maintenanceStarted.promise;
  context.mock.timers.tick(maintenance.execution_profile.maintenance_ms - 1);
  assert.equal(events.some((event) => event.phase === 'execution.armed'), false);
  assert.equal(events.some((event) => event.phase === 'maintenance.review'), false);
  context.mock.timers.tick(1);
  releaseMaintenance.resolve();
  await captureStarted.promise;
  const armed = events.find((event) => event.phase === 'execution.armed');
  context.mock.timers.tick(armed.execution_profile.capture_ms - 1);
  assert.equal(events.some((event) => event.phase === 'execution.fired'), false);
  context.mock.timers.tick(1);
  assert.equal(events.some((event) => event.phase === 'execution.fired'), true);
  releaseCapture.resolve();
  const capture = await finished.promise;
  const summary = events.find((event) => event.phase === 'maintenance.review');
  assert.equal(summary.reason, 'maintenance_timeout');
  assert.equal(probe.defaults.length, 0);
  assert.deepEqual(structuredClone(host.calls.map(({ argv }) => argv.slice(0, 2))), [['activity', 'record']]);
  return { maintenance: structuredClone(summary), capture: structuredClone(capture),
    timers: structuredClone(events.filter((event) => event.phase.startsWith('execution.'))),
    in_memory_activity_records: host.calls.length, blocked_bridge_attempts: probe.defaults.length,
    native_database: false, provider_dispatches: 0 };
}

module.exports = { driver };
if (require.main === module) {
  const cleanups = [];
  driver({ mock, after: (cleanup) => cleanups.push(cleanup) }).then((evidence) => {
    assert.equal(evidence.capture.execution_profile.capture_ms, 60000);
    assert.equal(evidence.maintenance.budgets.timeout_ms, 60000);
    console.log(JSON.stringify(evidence));
  }).finally(async () => {
    for (const cleanup of cleanups) await cleanup();
    mock.restoreAll();
  });
}
