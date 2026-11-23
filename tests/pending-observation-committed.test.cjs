const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./capture-pipeline-fixture.cjs');
const { driver } = require('./maintenance-observation-driver.cjs');
const { pump } = require('./capture-quality-population-native/pending-lifecycle-probe.cjs');

for (const action of ['timeout', 'new_input', 'cancel', 'dispose']) test(`saved capture survives pending terminal ${action} without replay`, async (context) => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const done = Promise.withResolvers();
  const current = await fixture(context, { onReview: done.resolve, onLifecycle(event) {
    if (event.phase === 'review.finished') { entered.resolve(); return gate.promise; }
  } });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  done.promise.then(() => { settled = true; });
  const pending = current.turn('u', 'Use concise Chinese in future.');
  await entered.promise;
  try {
    if (action === 'timeout') context.mock.timers.tick(30000);
    else if (action === 'new_input') current.capture.observe({ sessionID: 'parent' }, { message: { id: 'u2', role: 'user' }, parts: [{ type: 'text', text: 'A different task.' }] });
    else if (action === 'cancel') current.capture.event({ event: { type: 'session.error', properties: { sessionID: 'parent' } } });
    else void current.capture.dispose();
    await pump();
    assert.equal(settled, true);
    const summary = await done.promise;
    assert.equal(summary.status, 'saved'); assert.equal(summary.observation_warning, 'capture_observation_failed');
    assert.equal(summary.write_attempts, 1); assert.equal(summary.model_calls, 3);
    assert.deepEqual(summary.memory_ids, [1]);
    assert.deepEqual(current.calls.filter(({ type }) => ['write', 'readback'].includes(type)).map(({ type }) => type), ['write', 'readback']);
    const before = structuredClone(current.calls);
    gate.reject(new Error('late terminal rejection'));
    await pump();
    assert.deepEqual(current.calls, before);
    await pending;
    context.diagnostic(JSON.stringify({ action, summary, writes: 1, readbacks: 1, generations: 3, children: 2 }));
  } finally { gate.resolve(); }
});

for (const stage of ['raw_proposal', 'validated_decision', 'support_assessment', 'issuance']) test(`maintenance pending ${stage} times out before commit and cannot resume`, async (context) => {
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = driver({ observer(event) { if (event.stage === stage) { entered.resolve(); return gate.promise; } } });
  pending.then(() => { settled = true; });
  await entered.promise;
  try {
    context.mock.timers.tick(30000);
    await pump();
    assert.equal(settled, true);
    const result = await pending;
    assert.equal(result.summary.reason, 'maintenance_timeout');
    assert.equal(result.summary.observation_warning, 'maintenance_observation_failed');
    assert.equal(result.summary.write_attempts, 0);
    assert.equal(result.records[0].content, 'old route');
    gate.reject(new Error('late decision rejection'));
    await pump();
    assert.equal(result.requests.length, stage === 'support_assessment' || stage === 'issuance' ? 2 : 1);
  } finally { gate.resolve(); }
});

for (const phase of ['review.finished', 'maintenance.review']) {
  for (const action of ['timeout', 'new_input', 'cancel', 'dispose']) test(`committed maintenance survives pending ${phase} ${action} without replay`, async (context) => {
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let maintenance;
    let settled = false;
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = driver({ commit: true, ready: (current) => { maintenance = current; }, observer(event) {
      if (event.phase === phase) { entered.resolve(); return gate.promise; }
    } });
    pending.then(() => { settled = true; });
    await entered.promise;
    try {
      if (action === 'timeout') context.mock.timers.tick(30000);
      else if (action === 'new_input') maintenance.observe({ sessionID: 'parent' }, { message: { id: 'u2', role: 'user' }, parts: [{ type: 'text', text: 'A different task.' }] });
      else if (action === 'cancel') maintenance.event({ event: { type: 'session.error', properties: { sessionID: 'parent' } } });
      else void maintenance.dispose();
      await pump();
      assert.equal(settled, true);
      const result = await pending;
      const summary = action === 'dispose' ? result.events.at(-1) : result.summary;
      assert.equal(summary.status, 'committed'); assert.equal(summary.reason, 'committed');
      if (action !== 'dispose') assert.equal(summary.observation_warning, 'maintenance_observation_failed');
      assert.equal(summary.write_attempts, 1); assert.equal(summary.model_calls, 3);
      assert.equal(result.writes.length, 1); assert.equal(result.readbacks.length, 1);
      assert.equal(result.readbacks[0][0].content, 'new route');
      gate.reject(new Error('late committed observer rejection'));
      await pump();
      assert.equal(result.writes.length, 1); assert.equal(result.readbacks.length, 1);
      context.diagnostic(JSON.stringify({ phase, action, summary, writes: result.writes.length, readbacks: result.readbacks.length }));
    } finally { gate.resolve(); }
  });
}
