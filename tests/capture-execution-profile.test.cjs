const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./capture-pipeline-fixture.cjs');

for (const captureExecutionMs of [30000, 45000, 60000]) {
  for (const atDeadline of [false, true]) test(`${captureExecutionMs} capture ${atDeadline ? 'at' : 'before'} deadline after coordinator waiting`, async (context) => {
    const waiting = Promise.withResolvers(); const coordinator = Promise.withResolvers();
    const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const timers = [];
    const current = await fixture(context, { captureExecutionMs, onTimer: (event) => timers.push(event),
      coordinator: { owns: () => false, beforeReview() { waiting.resolve(); return coordinator.promise; } },
      beforeGeneration({ packet }) { if (!packet.content) context.mock.timers.tick(captureExecutionMs / 3); },
      beforeAsk: async () => { entered.resolve(); await release.promise; } });
    context.mock.timers.enable({ apis: ['setTimeout'] });

    const running = current.turn('user', 'Prefer concise Chinese in future.');
    await waiting.promise; context.mock.timers.tick(40000); coordinator.resolve(true); await entered.promise;
    context.mock.timers.tick(captureExecutionMs / 3 - 1);
    const abortedBeforeDeadline = current.calls.some(({ type }) => type === 'abort');
    if (atDeadline) context.mock.timers.tick(1);
    release.resolve(); const result = await running;

    assert.equal(abortedBeforeDeadline, false);
    assert.equal(result.detail.metadata.status, atDeadline ? 'skipped' : 'saved');
    assert.equal(current.calls.filter(({ type }) => type === 'write').length, atDeadline ? 0 : 1);
    assert.equal(timers.find(({ phase }) => phase === 'execution.armed').execution_profile.capture_ms, captureExecutionMs);
    assert.equal(timers.some(({ phase }) => phase === 'execution.fired'), atDeadline);
  });

  test(`${captureExecutionMs} sequential generations cannot renew capture window`, async (context) => {
    const current = await fixture(context, { captureExecutionMs,
      beforeGeneration() { context.mock.timers.tick(captureExecutionMs / 3); } });
    context.mock.timers.enable({ apis: ['setTimeout'] });

    const result = await current.turn('user', 'Prefer concise Chinese in future.');

    assert.equal(result.detail.metadata.reason, 'capture_timeout');
    assert.equal(current.calls.filter(({ type }) => type === 'generation').length, 3);
    assert.equal(current.calls.some(({ type }) => type === 'write'), false);
  });

  for (const boundary of ['new_input', 'deny', 'unknown']) test(`${captureExecutionMs} preserves ${boundary} terminal safety`, async (context) => {
    const current = await fixture(context, { captureExecutionMs, deny: boundary === 'deny', unknown: boundary === 'unknown',
      beforeAsk: boundary === 'new_input' ? () => current.capture.observe({ sessionID: 'parent' },
        { message: { id: 'new', role: 'user' }, parts: [{ type: 'text', text: 'Different task.' }] }) : undefined,
      afterSpawn: boundary === 'unknown' ? () => context.mock.timers.tick(captureExecutionMs) : undefined });
    context.mock.timers.enable({ apis: ['setTimeout'] });

    const result = await current.turn('user', 'Prefer concise Chinese in future.');

    assert.equal(result.detail.metadata.status, { new_input: 'skipped', deny: 'denied', unknown: 'unknown' }[boundary]);
    assert.equal(current.calls.filter(({ type }) => type === 'write').length, boundary === 'unknown' ? 1 : 0);
    assert.equal(current.calls.filter(({ type }) => type === 'readback').length, boundary === 'unknown' ? 1 : 0);
    assert.equal(current.calls.filter(({ type }) => type === 'generation').length, 3);
  });
}

for (const captureExecutionMs of [45000, 60000]) test(`${captureExecutionMs} extraction request still aborts at individual 30000`, async (context) => {
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const current = await fixture(context, { captureExecutionMs, beforeGeneration({ signal }) {
    entered.resolve(signal); return release.promise;
  } });
  context.mock.timers.enable({ apis: ['setTimeout'] });

  const running = current.turn('user', 'Prefer concise Chinese in future.'); const signal = await entered.promise;
  context.mock.timers.tick(29999); assert.equal(signal.aborted, false);
  context.mock.timers.tick(1); const abortedAtDeadline = signal.aborted;
  release.resolve(); const result = await running;

  assert.equal(abortedAtDeadline, true);
  assert.equal(result.detail.metadata.reason, 'provider_timeout');
  assert.equal(current.calls.some(({ type }) => type === 'write'), false);
});

for (const captureExecutionMs of [30000, 45000, 60000]) test(`${captureExecutionMs} cannot refresh expired observed evidence during coordinator wait`, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
  const current = await fixture(context, { captureExecutionMs,
    observationClock: { now: () => Date.now(), setTimeout: (...args) => setTimeout(...args), clearTimeout: (timer) => clearTimeout(timer) },
    coordinator: { owns: () => false, beforeReview() { context.mock.timers.tick(100000); return true; } },
    beforeAsk() { context.mock.timers.tick(20001); } });

  const result = await current.turn('user', 'Prefer concise Chinese in future.');

  assert.equal(result.detail.metadata.reason, 'new_input');
  assert.equal(result.detail.metadata.write_attempts, 0);
  assert.equal(current.calls.filter(({ type }) => type === 'generation').length, 3);
  assert.equal(current.calls.some(({ type, id }) => type === 'history' && id === 'parent'), false);
});
