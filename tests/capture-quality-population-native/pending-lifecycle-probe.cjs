const { productionProbe } = require('./production-probe.cjs');
const { getEventListeners } = require('node:events');

async function pump() { for (let index = 0; index < 100; index++) await Promise.resolve(); }

async function pendingProbe(context, options) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const timers = new Map();
  const schedule = setTimeout;
  const clear = clearTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = schedule(() => { timers.delete(timer); callback(); }, delay);
    timers.set(timer, delay);
    return timer;
  });
  context.mock.method(globalThis, 'clearTimeout', (timer) => { timers.delete(timer); clear(timer); });
  let now = 0;
  const probe = await productionProbe({ performance: { timeOrigin: 7, now: () => now } });
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const events = [];
  const cleaned = [];
  const jobs = new Set();
  const summaries = new Map();
  const runtime = { warnings: [], context: async () => ({}), request: async () => { records++; return {}; } };
  let records = 0;
  let reviews = 0;
  let settled = false;
  let disposed = false;
  let turn;
  const observation = (event) => {
    events.push(event);
    if (event.phase === options.phase) {
      if (options.abortInside) (tasks ?? surface).event({ event: { type: 'session.error', properties: { sessionID: 'root' } } });
      entered.resolve(); return gate.promise;
    }
  };
  const client = { session: { get: async () => ({ data: { parentID: 'foreign' } }),
    abort: async () => { cleaned.push('abort'); return { data: true }; },
    delete: async () => { cleaned.push('delete'); return { data: true }; } },
    tool: { ids: async () => ({ data: [] }) }, _client: { get: async () => ({ data: {} }) } };
  let surface;
  let pending;
  let tasks;
  if (options.workflow === 'capture') {
    const { createCapture } = (await probe.load('../../plugin/capture/index.js')).namespace;
    surface = createCapture({ client, captureObservation: { onLifecycle: observation, onReview() { settled = true; } },
      captureCoordinator: { owns: () => false, beforeReview(current) { turn = current; return true; } } }, runtime, {});
    surface.observe({ sessionID: 'root' }, { message: { id: 'user', role: 'user' }, parts: [{ id: 'text', type: 'text', text: 'Review alpha route.' }] });
    surface.event({ event: { type: 'session.status', properties: { sessionID: 'root', status: { type: 'idle' } } } });
  } else if (options.workflow === 'scheduler') {
    const { createMaintenanceTasks } = (await probe.load('../../plugin/maintenance/tasks.js')).namespace;
    const { createMaintenanceScheduler } = (await probe.load('../../plugin/maintenance/scheduler.js')).namespace;
    const { createMaintenanceFrames } = (await probe.load('../../plugin/maintenance/continuity.js')).namespace;
    const frames = createMaintenanceFrames();
    tasks = createMaintenanceTasks(() => {}, frames);
    turn = { task: { parentID: 'root', taskID: 'task', epoch: 1 }, userID: 'user', phase: 'observed',
      controller: new AbortController(), children: ['child'], used: [{}], evidence: new Map([['source', {}]]),
      messages: new Map([['assistant', { finish: 'stop', completed: 1 }]]), toolStates: new Map(), model_calls: 0, tool_calls: 0, write_attempts: 0 };
    tasks.parents.set('root', turn); tasks.workers.set('child', { turn });
    surface = createMaintenanceScheduler({ client, runtime, tasks, frames, summaries, jobs, observation,
      reviewer: { async review(current) { reviews++; tasks.check(current); return { status: 'no_candidate' }; } } });
    pending = surface.beforeReview({ parentID: 'root', userID: 'user' }).then(() => { settled = true; });
  } else {
    const { createMaintenance } = (await probe.load('../../plugin/maintenance/runtime.js')).namespace;
    surface = createMaintenance({ client, maintenanceObservation: observation }, runtime, { invoke: async () => { throw new Error('unexpected_native'); } });
    surface.observe({ sessionID: 'root' }, { message: { id: 'user', role: 'user' }, parts: [{ id: 'text', type: 'text', text: 'Review alpha route.' }] });
    surface.event({ event: { type: 'message.updated', properties: { info: { sessionID: 'root', id: 'assistant', parentID: 'user', role: 'assistant', finish: 'stop', time: { completed: 1 } } } } });
    pending = surface.coordinator.beforeReview({ parentID: 'root', userID: 'user' }).then(() => { settled = true; });
  }
  await entered.promise;
  const observationSignal = turn?.observation?.signal;
  const dispose = async () => {
    if (options.workflow === 'scheduler') { tasks.dispose(); await Promise.allSettled([...jobs]); }
    else await surface.dispose();
    disposed = true;
  };
  const advance = (milliseconds) => { now += milliseconds; context.mock.timers.tick(milliseconds); };
  const stop = async (action) => {
    if (action === 'timeout') { advance(29999); await pump();
      if (settled) throw new Error('review_settled_before_deadline');
      advance(1); }
    else if (action === 'dispose') void dispose();
    else if (action === 'new_input') (tasks ?? surface).observe({ sessionID: 'root' }, { message: { id: 'next', role: 'user' }, parts: [{ type: 'text', text: 'A different task.' }] });
    else (tasks ?? surface).event({ event: { type: 'session.error', properties: { sessionID: 'root' } } });
    await pump();
  };
  const snapshot = () => ({ now, settled, disposed, records, reviews, timers: timers.size,
    review_timers: [...timers.values()].filter((delay) => delay === 30000).length,
    jobs: options.workflow === 'scheduler' ? jobs.size : null, workers: tasks?.workers.size,
    evidence: turn?.evidence?.size, used: turn?.used?.length, cleaned: [...cleaned],
    aborted: turn?.controller.signal.aborted, listeners: observationSignal ? getEventListeners(observationSignal, 'abort').length : null,
    summary: options.workflow === 'capture' ? runtime.captureStatus('root') : options.workflow === 'scheduler' ? summaries.get('root')?.value : runtime.maintenanceStatus('root'),
    phases: events.map((event) => event.phase) });
  context.after(async () => { gate.resolve(); await pump(); await dispose(); await pending; });
  return { gate, events, stop, snapshot, dispose, pump, probe, advance };
}
module.exports = { pendingProbe, pump };
