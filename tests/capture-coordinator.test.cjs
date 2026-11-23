const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./capture-pipeline-fixture.cjs');
const flush = () => new Promise(setImmediate);
const { driver } = require('./maintenance-observation-driver.cjs');

for (const [name, options, status, reason, allowed] of [
  ['denied proposal', { deny: true }, 'proposal', 'permission_deny', false],
  ['grant required', {}, 'proposal', 'maintenance_grant_required', false],
  ['native ask refusal', { commit: true, nativeDeny: true }, 'denied', 'native_permission_denied', false],
  ['no revision', { decision: () => null }, 'no_candidate', 'no_revision', true],
  ['keep', { decision: (decision) => ({ action: 'keep', target: decision.target }) }, 'keep', 'no_revision', true],
  ['unknown decision', { decision: (decision) => ({ action: 'unknown', target: decision.target }) }, 'unknown', 'no_revision', true],
  ['unsupported', { support: 'unsupported' }, 'unknown', 'unsupported', true],
  ['unknown support', { support: 'unknown' }, 'unknown', 'unknown', true],
  ['invalid proposal', { decision: (decision) => ({ ...decision, extra: true }) }, 'blocked', 'invalid_request', false],
  ['verified commit', { commit: true, observer: (event) => {
    if (event.phase === 'review.finished') throw new Error('injected observation warning');
  } }, 'committed', 'committed', true],
]) test(`real maintenance ${name} ${allowed ? 'admits' : 'blocks'} same-turn capture`, async (t) => {
  let current;
  let review;
  let repeated;
  const result = await driver({ ...options, ready: async (maintenance) => {
    current = await fixture(t, { coordinator: maintenance.coordinator });
    review = await current.turn('user', 'Check current route');
    repeated = await maintenance.coordinator.beforeReview({ parentID: 'parent', userID: 'user' });
  } });
  assert.equal(result.summary.status, status);
  assert.equal(result.summary.reason, reason);
  assert.equal(review.detail.metadata.status, allowed ? 'saved' : 'skipped');
  assert.deepEqual(review.detail.metadata.memory_ids, allowed ? [1] : []);
  assert.equal(current.calls.filter(({ type }) => type === 'generation').length, allowed ? 3 : 0);
  assert.deepEqual(current.calls.filter(({ type }) => ['ask', 'write', 'readback'].includes(type)).map(({ type }) => type),
    allowed ? ['ask', 'write', 'readback'] : []);
  assert.equal(repeated, allowed);
  assert.equal(result.asks.length, options.commit ? 1 : 0);
  assert.equal(result.writes.length, status === 'committed' ? 1 : 0);
  if (status === 'committed') {
    assert.equal(result.readbacks.length, 1);
    assert.equal(result.readbacks[0][0].content, 'new route');
    assert.equal(result.summary.observation_warning, 'maintenance_observation_failed');
  }
});

async function scheduledFixture(t, outcome, options = {}) {
  const { createMaintenanceTasks } = await import('../plugin/maintenance/tasks.js');
  const { createMaintenanceFrames } = await import('../plugin/maintenance/continuity.js');
  const { createMaintenanceScheduler } = await import('../plugin/maintenance/scheduler.js');
  const frames = createMaintenanceFrames();
  const tasks = createMaintenanceTasks(() => {}, frames);
  t.after(() => tasks.dispose());
  tasks.observe({ sessionID: 'parent' }, { message: { id: 'u', role: 'user' }, parts: [{ id: 'source', type: 'text', text: 'Use concise Chinese in future.' }] });
  tasks.event({ event: { type: 'message.updated', properties: { info: { id: 'assistant', sessionID: 'parent', role: 'assistant', parentID: 'u', finish: 'stop', time: { completed: 1 } } } } });
  const turn = tasks.parents.get('parent');
  turn.write_attempts = options.writes ?? 0;
  const scheduler = createMaintenanceScheduler({ tasks, frames, jobs: new Set(), summaries: new Map(),
    reviewer: { review: async () => { await options.review?.(turn, tasks); return outcome; } } });
  const current = await fixture(t, { coordinator: { owns: () => false, beforeReview: scheduler.beforeReview } });
  return { ...current, turnState: turn, tasks, scheduler };
}

for (const [status, reason, writes, allowed] of [
  ['no_candidate', 'no_adopted_records', 0, true],
  ['no_candidate', undefined, 0, false],
  ...['evidence_unavailable', 'input_budget', 'continuity_unknown'].map((reason) => ['unknown', reason, 0, true]),
  ['unknown', 'no_revision', 1, false],
  ['unknown', 'unsupported', 1, false],
  ['unknown', 'apply_not_called', 0, false],
  ['unknown', 'outcome_unknown', 1, false],
  ['conflict', 'rolled_back', 1, false],
  ['blocked', 'no_revision', 0, false],
  ['denied', 'no_revision', 0, false],
  ['future_status', 'no_revision', 0, false],
  ['keep', 'future_reason', 0, false],
  ['committed', 'future_reason', 1, false],
]) test(`scheduler ${status}/${reason} with ${writes} writes ${allowed ? 'admits' : 'blocks'} capture`, async (t) => {
  const current = await scheduledFixture(t, { status, reason }, { writes });
  const result = await current.turn('u', 'Use concise Chinese in future.');
  assert.equal(result.detail.metadata.status, allowed ? 'saved' : 'skipped');
  assert.equal(current.calls.filter(({ type }) => type === 'write').length, allowed ? 1 : 0);
});

for (const reason of ['evidence_unavailable', 'input_budget', 'unknown', 'future_invalidation']) {
  test(`task invalidation ${reason} overrides an otherwise admissible outcome`, async (t) => {
    const current = await scheduledFixture(t, { status: 'unknown', reason: 'no_revision' }, {
      review: (turn, tasks) => tasks.invalidate(turn, reason),
    });
    const result = await current.turn('u', 'Use concise Chinese in future.');
    assert.equal(result.detail.metadata.reason, 'coordinator_cancelled');
    assert.equal(current.calls.length, 0);
  });
}

test('new input while actual scheduler awaits commitPending never revives obsolete capture', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const current = await scheduledFixture(t, { status: 'unknown', reason: 'apply_not_called' }, {
    review(turn) { turn.commitPending = release.promise.then(() => { turn.outcome = { status: 'committed', reason: 'committed' }; }); entered.resolve(); },
  });
  const review = current.turn('u', 'Use concise Chinese in future.');
  await entered.promise;
  const next = { message: { id: 'next', role: 'user' }, parts: [{ type: 'text', text: 'Different task' }] };
  current.tasks.observe({ sessionID: 'parent' }, next);
  current.capture.observe({ sessionID: 'parent' }, next);
  release.resolve();
  const result = await review;
  assert.equal(result.detail.metadata.reason, 'new_input');
  assert.equal(await current.scheduler.beforeReview({ parentID: 'parent', userID: 'u' }), false);
  assert.equal(current.calls.length, 0);
});

test('scheduler waits for the final commit outcome before admitting capture', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const current = await scheduledFixture(t, { status: 'unknown', reason: 'apply_not_called' }, {
    review(turn) { turn.commitPending = release.promise.then(() => { turn.outcome = { status: 'committed', reason: 'committed' }; }); entered.resolve(); },
  });
  const review = current.turn('u', 'Use concise Chinese in future.');
  await entered.promise;
  await flush();
  assert.equal(current.calls.length, 0);
  release.resolve();
  assert.equal((await review).detail.metadata.status, 'saved');
  assert.deepEqual(current.calls.filter(({ type }) => ['write', 'readback'].includes(type)).map(({ type }) => type), ['write', 'readback']);
});

test('secret user input keeps its explicit reason through the actual maintenance coordinator without dispatch or native write', async (t) => {
  const { createMaintenanceTasks } = await import('../plugin/maintenance/tasks.js');
  const { createMaintenanceFrames } = await import('../plugin/maintenance/continuity.js');
  const { createMaintenanceScheduler } = await import('../plugin/maintenance/scheduler.js');
  const tasks = createMaintenanceTasks(() => {}, createMaintenanceFrames());
  t.after(() => tasks.dispose());
  const scheduler = createMaintenanceScheduler({ tasks });
  let coordinatorResult;
  const current = await fixture(t, { coordinator: { owns: () => false, beforeReview: async (turn) => {
    coordinatorResult = await scheduler.beforeReview(turn);
    return coordinatorResult;
  } } });
  const text = 'For this local fixture api_key=synthetic-never-real';
  tasks.observe({ sessionID: 'parent' }, { message: { id: 'u', role: 'user' }, parts: [{ type: 'text', text }] });

  const review = await current.turn('u', text);

  assert.equal(tasks.parents.get('parent').reason, 'evidence_unavailable');
  assert.equal(coordinatorResult, false);
  assert.equal(current.calls.length, 0);
  assert.equal(review.detail.metadata.model_calls, 0);
  assert.equal(review.detail.metadata.write_attempts, 0);
  assert.equal(review.detail.metadata.reason, 'secret');
});

test('capture gets its own full budget after maintenance waits beyond thirty seconds', async (t) => {
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  const current = await fixture(t, { coordinator: { owns: () => false, beforeReview: () => { ready.resolve(); return release.promise; } } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const review = current.turn('u', 'Use concise Chinese in future.');
  await ready.promise;
  t.mock.timers.tick(30001);
  release.resolve();
  const result = await review;
  assert.equal(result.detail.metadata.status, 'saved');
  assert.equal(result.detail.metadata.model_calls, 3);
  assert.equal(current.calls.filter((call) => call.type === 'write').length, 1);
  t.mock.timers.tick(30001);
  assert.equal(current.calls.filter((call) => call.type === 'abort').length, 0);
});

test('capture still times out when its own prewrite work exceeds thirty seconds', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const current = await fixture(t, { beforeAsk: async () => { entered.resolve(); await release.promise; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const review = current.turn('u', 'Use concise Chinese in future.');
  await entered.promise;
  t.mock.timers.tick(29999);
  assert.equal(current.calls.some((call) => call.type === 'abort'), false);
  t.mock.timers.tick(2);
  release.resolve();
  const result = await review;
  assert.equal(result.detail.metadata.reason, 'capture_timeout');
  assert.equal(current.calls.some((call) => call.type === 'write'), false);
});

for (const action of ['new_input', 'cancel', 'false', 'throw', 'dispose']) {
  test(`${action} during coordinator wait prevents obsolete extraction and native spawn`, async (t) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const current = await fixture(t, { coordinator: { owns: () => false, beforeReview: () => { entered.resolve(); return release.promise; } } });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const review = current.turn('u', 'Use concise Chinese in future.');
    await entered.promise;
    let disposing;
    switch (action) {
      case 'new_input': current.capture.observe({ sessionID: 'parent' }, { message: { id: 'u2', role: 'user' }, parts: [{ type: 'text', text: 'Different task' }] }); break;
      case 'cancel': current.capture.event({ event: { type: 'session.error', properties: { sessionID: 'parent' } } }); break;
      case 'dispose': disposing = current.capture.dispose(); break;
      case 'false': break;
      case 'throw': release.reject(new Error('coordinator failed')); break;
      default: assert.fail(action);
    }
    release.resolve(action === 'false' ? false : undefined);
    const result = await review;
    await disposing;
    await flush();
    t.mock.timers.tick(60001);
    assert.equal(current.calls.length, 0);
    assert.equal(result.detail.metadata.model_calls, 0);
    assert.equal(result.detail.metadata.write_attempts, 0);
    assert.equal(result.detail.metadata.reason, { new_input: 'new_input', cancel: 'parent_error', false: 'coordinator_cancelled', throw: 'capture_failed', dispose: 'disposed' }[action]);
  });
}

test('timeout after native spawn preserves independent reconciliation without replay', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const current = await fixture(t, { afterSpawn: async () => { entered.resolve(); await release.promise; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const review = current.turn('u', 'Use concise Chinese in future.');
  await entered.promise;
  t.mock.timers.tick(30001);
  release.resolve();
  const result = await review;
  assert.equal(result.detail.metadata.status, 'saved');
  assert.deepEqual(current.calls.filter((call) => ['write', 'readback'].includes(call.type)).map((call) => call.type), ['write', 'readback']);
});
