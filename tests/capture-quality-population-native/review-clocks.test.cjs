const test = require('node:test');
const assert = require('node:assert/strict');
const { productionProbe } = require('./production-probe.cjs');

for (const phase of ['review.started', 'review.finished']) test(`synchronous maintenance ${phase} failure finishes and cleans the existing worker`, async () => {
  const probe = await productionProbe(); const summaries = new Map(); let reviews = 0; const cleaned = [];
  const { createMaintenanceScheduler } = (await probe.load('../../plugin/maintenance/scheduler.js')).namespace;
  const turn = { userID: 'user', task: { parentID: 'root', taskID: 'task', epoch: 1 }, children: ['child'],
    evidence: new Map([['evidence', {}]]), used: [{}], model_calls: 0, tool_calls: 0, write_attempts: 0 };
  const tasks = { parents: new Map([['root', turn]]), workers: new Map([['child', {}]]), complete: () => true, invalidate() {} };
  const scheduler = createMaintenanceScheduler({ tasks, summaries, jobs: new Set(), runtime: { warnings: [] }, frames: { save() {} },
    reviewer: { review: async () => { reviews++; return { status: 'no_candidate', reason: 'no_adopted_records' }; } },
    client: { session: { abort: async () => { cleaned.push('abort'); return { data: true }; },
      delete: async () => { cleaned.push('delete'); return { data: true }; } } },
    observation(event) { if (event.phase === phase) throw new Error('synchronous sink rejected'); } });
  const allowed = await scheduler.beforeReview({ parentID: 'root', userID: 'user' });
  assert.equal(turn.phase, 'finished'); assert.equal(tasks.workers.size, 0);
  assert.equal(turn.evidence.size, 0); assert.equal(turn.used.length, 0); assert.deepEqual(cleaned, ['abort', 'delete']);
  assert.equal(reviews, phase === 'review.started' ? 0 : 1); assert.equal(allowed, phase !== 'review.started');
  assert.equal(summaries.get('root').value.status, phase === 'review.started' ? 'blocked' : 'no_candidate');
});

test('capture clock encloses coordinator wait and review recording without changing execution timer', async () => {
  let now = 10; const events = []; const gate = Promise.withResolvers(); const entered = Promise.withResolvers();
  const probe = await productionProbe({ performance: { timeOrigin: 42, now: () => now } });
  const { createCapture } = (await probe.load('../../plugin/capture/index.js')).namespace;
  const done = Promise.withResolvers(); let calls = 0;
  const permission = [{ permission: '*', pattern: '*', action: 'allow' }];
  const client = { _client: { get: async () => ({ data: { version: '1.19.3' } }) },
    tool: { ids: async () => ({ data: ['memocap_remember'] }) }, app: { agents: async () => ({ data: [{ name: 'build', permission }] }) },
    session: { get: async () => ({ data: { permission } }), create: async () => ({ data: { id: 'child' } }),
      prompt: async () => { calls++; now += 20; return { data: { info: { finish: 'stop' }, parts: [{ type: 'text', text: '{"candidates":[]}' }] } }; },
      abort: async () => ({ data: true }), delete: async () => ({ data: true }) } };
  const runtime = { warnings: [], context: async () => ({ generation: 1, targets: [{ repository_id: 'repository:fixture' }] }),
    readPermission: { check: async () => {} }, recall: async () => ({ status: 'empty', results: [] }),
    request: async () => { now += 30; return {}; } };
  const capture = createCapture({ client, captureCoordinator: { owns: () => false, beforeReview() { entered.resolve(); return gate.promise; } },
    captureObservation: { onLifecycle: (event) => events.push(event), onReview: done.resolve } }, runtime, {});
  capture.observe({ sessionID: 'root', agent: 'build', model: { providerID: 'synthetic', modelID: 'synthetic' } },
    { message: { id: 'user', role: 'user' }, parts: [{ id: 'part', type: 'text', text: 'Prefer concise Chinese for future responses.' }] });
  capture.event({ event: { type: 'message.updated', properties: { info: { sessionID: 'root', id: 'assistant', role: 'assistant',
    parentID: 'user', finish: 'stop', time: { created: 1, completed: 2 } } } } });
  capture.event({ event: { type: 'session.status', properties: { sessionID: 'root', status: { type: 'idle' } } } });
  await entered.promise;
  assert.equal(events.length, 0); assert.equal(calls, 0);
  now += 40000; gate.resolve(true); await done.promise; await capture.dispose();
  assert.deepEqual(events.map(({ phase }) => phase), ['review.started', 'review.finished']);
  assert.equal(events[1].monotonic_ms - events[0].monotonic_ms, 40050);
  assert.equal(events[1].clock_domain, events[0].clock_domain);
  assert.equal(events[0].monotonic_ms, 10);
  assert.equal(events[1].review_id, events[0].review_id); assert.equal(calls, 1);
});
test('maintenance clock encloses origin admission commit wait and child cleanup', async () => {
  let now = 5; const events = []; const probe = await productionProbe({ performance: { timeOrigin: 42, now: () => now } });
  const { createMaintenanceScheduler } = (await probe.load('../../plugin/maintenance/scheduler.js')).namespace;
  const turn = { userID: 'user', task: { parentID: 'root', taskID: 'task', epoch: 1 }, children: ['child'],
    evidence: new Map(), used: [], model_calls: 1, tool_calls: 0, write_attempts: 0 };
  const tasks = { parents: new Map([['root', turn]]), workers: new Map([['child', {}]]), complete: () => true, invalidate() {} };
  const scheduler = createMaintenanceScheduler({ tasks, summaries: new Map(), jobs: new Set(), runtime: { warnings: [] },
    frames: { save() { now += 7; } }, reviewer: { review: async () => { now += 11; return { status: 'no_change' }; } },
    client: { session: { abort: async () => { now += 13; return { data: true }; }, delete: async () => { now += 17; return { data: true }; } } },
    observation: (event) => events.push(event) });
  await scheduler.beforeReview({ parentID: 'root', userID: 'user' });
  const clocks = events.filter(({ phase }) => phase.startsWith('review.'));
  assert.deepEqual(clocks.map(({ phase }) => phase), ['review.started', 'review.finished']);
  assert.equal(clocks[1].monotonic_ms - clocks[0].monotonic_ms, 48);
  assert.equal(clocks[1].clock_domain, 'node.performance:42'); assert.equal(tasks.workers.size, 0);
});

test('public capture keeps 30000ms execution after 40000ms coordinator wait with true entry clock', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 5;
  const probe = await productionProbe({ performance: { timeOrigin: 7, now: () => now } });
  const { createCapture } = (await probe.load('../../plugin/capture/index.js')).namespace;
  const coordinator = Promise.withResolvers();
  const waiting = Promise.withResolvers();
  const working = Promise.withResolvers();
  const release = Promise.withResolvers();
  const done = Promise.withResolvers();
  const events = [];
  const runtime = { warnings: [], context: async () => ({}), request: async () => ({}) };
  const client = { session: { get({ signal }) { working.resolve(signal); return release.promise; } },
    tool: { ids: async () => ({ data: [] }) }, _client: { get: async () => ({ data: {} }) } };
  const capture = createCapture({ client, captureObservation: { onLifecycle: (event) => events.push(event), onReview: done.resolve },
    captureCoordinator: { owns: () => false, beforeReview() { waiting.resolve(); return coordinator.promise; } } }, runtime, {});
  capture.observe({ sessionID: 'root' }, { message: { id: 'user', role: 'user' }, parts: [{ type: 'text', text: 'Check alpha route.' }] });
  capture.event({ event: { type: 'session.status', properties: { sessionID: 'root', status: { type: 'idle' } } } });
  await waiting.promise;
  now += 40000; context.mock.timers.tick(40000);
  assert.equal(events.length, 0);
  coordinator.resolve(true);
  const signal = await working.promise;
  now += 29999; context.mock.timers.tick(29999);
  assert.equal(signal.aborted, false);
  now++; context.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  release.resolve({ data: { parentID: 'foreign' } });
  const summary = await done.promise;
  assert.equal(summary.reason, 'capture_timeout'); assert.equal(summary.write_attempts, 0);
  assert.equal(events[0].monotonic_ms, 5); assert.equal(events[1].monotonic_ms, 70005);
  assert.equal(events[0].review_id, events[1].review_id); assert.equal(events[0].clock_domain, 'node.performance:7');
  await capture.dispose();
  context.diagnostic(JSON.stringify({ coordinator_ms: 40000, execution_ms: 30000, review_elapsed_ms: 70000, clock_domain: events[0].clock_domain, summary }));
});
