const assert = require('node:assert/strict');
const test = require('node:test');
const { driver } = require('./maintenance-observation-driver.cjs');
test.afterEach(() => test.mock.restoreAll());

for (const maintenanceExecutionMs of [45000, 60000]) for (const stage of ['extract', 'support', 'commit']) {
  test(`maintenance${maintenanceExecutionMs} cancels a stalled ${stage} request at30 before any write`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
    let aborted;
    const result = await driver({ maintenanceExecutionMs, commit: true,
      onPrompt({ packet, signal }) {
        if (packet.stage !== stage) return;
        context.mock.timers.tick(29999);
        assert.equal(signal.aborted, false);
        context.mock.timers.tick(1);
        aborted = signal.aborted;
        throw Object.assign(new Error('synthetic end'), { code: 'local_probe_end' });
      } });
    assert.equal(aborted, true);
    assert.equal(result.summary.reason, 'provider_timeout');
    assert.equal(result.requests.at(-1).stage, stage);
    assert.equal(result.summary.write_attempts, 0);
    assert.equal(result.writes.length, 0);
    assert.equal(result.records[0].content, 'old route');
    assert.equal(result.captureAllowed, false);
    assert.equal(result.repeated, false);
  });
}

for (const maintenanceExecutionMs of [45000, 60000]) test(`maintenance${maintenanceExecutionMs} rejects a late provider response even when the SDK ignores cancellation`, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
  const result = await driver({ maintenanceExecutionMs, commit: true,
    onPrompt() { context.mock.timers.tick(30000); } });
  assert.equal(result.summary.reason, 'provider_timeout');
  assert.deepEqual(result.requests.map(({ stage }) => stage), ['extract']);
  assert.equal(result.writes.length, 0);
  assert.equal(result.captureAllowed, false);
});

for (const maintenanceExecutionMs of [45000, 60000]) for (const lostReply of [false, true]) {
  test(`maintenance${maintenanceExecutionMs} request timeout preserves independent dispatched ${lostReply ? 'unknown' : 'committed'} readback`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
    let modelSignal;
    const result = await driver({ maintenanceExecutionMs, commit: true,
      onPrompt({ packet, signal }) { if (packet.stage === 'commit') modelSignal = signal; },
      afterWrite({ signal }) {
        context.mock.timers.tick(30000);
        assert.equal(modelSignal.aborted, true);
        assert.equal(signal.aborted, false);
        if (lostReply) throw Object.assign(new Error('injected lost reply'), { code: 'lost_reply' });
      } });
    assert.equal(result.summary.status, lostReply ? 'unknown' : 'committed');
    assert.equal(result.summary.reason, lostReply ? 'outcome_unknown' : 'committed');
    assert.equal(result.summary.write_attempts, 1);
    assert.equal(result.writes.length, 1);
    assert.equal(result.readbacks[0][0].content, 'new route');
    assert.equal(result.captureAllowed, !lostReply);
    assert.equal(result.repeated, !lostReply);
  });
}

for (const maintenanceExecutionMs of [undefined, 30000, 45000, 60000]) {
  test(`public maintenance shares ${maintenanceExecutionMs ?? 'default30'} across preparation and all generations`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
    const window = maintenanceExecutionMs ?? 30000;
    const preparation = window === 60000 ? 6000 : 1000;
    const stages = [];
    const result = await driver({ maintenanceExecutionMs, commit: true,
      observer(event) { if (event.phase === 'review.started') context.mock.timers.tick(preparation); },
      onPrompt({ packet, signal }) {
        stages.push(packet.stage);
        if (packet.stage === 'extract') context.mock.timers.tick(22000);
        if (packet.stage === 'support') context.mock.timers.tick(5000);
        if (packet.stage === 'commit') {
          context.mock.timers.tick(window - preparation - 27001);
          assert.equal(signal.aborted, false);
          context.mock.timers.tick(1);
          assert.equal(signal.aborted, true);
        }
      } });
    assert.deepEqual(stages, ['extract', 'support', 'commit']);
    assert.equal(result.summary.reason, 'maintenance_timeout');
    assert.equal(result.summary.budgets.timeout_ms, window);
    assert.equal(result.records[0].content, 'old route');
    assert.equal(result.summary.write_attempts, 0);
    assert.equal(result.captureAllowed, false);
    assert.equal(result.repeated, false);
  });
}

for (const maintenanceExecutionMs of [45000, 60000]) for (const event of ['new_input', 'parent_signal']) {
  test(`maintenance${maintenanceExecutionMs} ${event} prevents support and mutation`, async () => {
    const result = await driver({ maintenanceExecutionMs, commit: true,
      onPrompt({ maintenance }) {
        if (event === 'new_input') maintenance.observe({ sessionID: 'parent', agent: 'build' }, {
          message: { id: 'new-user', role: 'user' }, parts: [{ id: 'new-source', type: 'text', text: 'New actual request' }] });
        else maintenance.event({ event: { type: 'session.error', properties: { sessionID: 'parent' } } });
      } });
    assert.equal(result.summary.reason, event);
    assert.deepEqual(result.requests.map(({ stage }) => stage), ['extract']);
    assert.equal(result.records[0].content, 'old route');
    assert.equal(result.captureAllowed, false);
  });
}

for (const maintenanceExecutionMs of [45000, 60000]) test(`maintenance${maintenanceExecutionMs} native denial is terminal and blocks capture`, async () => {
  const result = await driver({ maintenanceExecutionMs, commit: true, nativeDeny: true });
  assert.equal(result.summary.status, 'denied');
  assert.equal(result.summary.write_attempts, 0);
  assert.equal(result.records[0].content, 'old route');
  assert.equal(result.captureAllowed, false);
  assert.equal(result.repeated, false);
});

for (const maintenanceExecutionMs of [45000, 60000]) test(`maintenance${maintenanceExecutionMs} dispatched unknown reconciles independently after timeout without replay or capture`, async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
  const result = await driver({ maintenanceExecutionMs, commit: true,
    afterWrite({ maintenance, signal }) {
      context.mock.timers.tick(maintenanceExecutionMs);
      maintenance.observe({ sessionID: 'parent', agent: 'build' }, { message: { id: 'new-user', role: 'user' },
        parts: [{ id: 'new-source', type: 'text', text: 'New request after dispatch' }] });
      assert.equal(signal.aborted, false);
      throw Object.assign(new Error('injected lost reply'), { code: 'lost_reply' });
    } });
  assert.equal(result.summary.status, 'unknown');
  assert.equal(result.summary.write_attempts, 1);
  assert.equal(result.records[0].content, 'new route');
  assert.equal(result.readbacks[0][0].content, 'new route');
  assert.equal(result.writes.length, 1);
  assert.equal(result.captureAllowed, false);
  assert.equal(result.repeated, false);
});

test('maintenance60 completes beyond45 with three generations two children and one readback write', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
  const result = await driver({ maintenanceExecutionMs: 60000, commit: true,
    observer(event) { if (event.phase === 'review.started') context.mock.timers.tick(1000); },
    onPrompt({ packet, signal }) {
      context.mock.timers.tick(packet.stage === 'commit' ? 10000 : 24000);
      assert.equal(signal.aborted, false);
    } });
  assert.equal(Date.now() - 100, 59000);
  assert.equal(result.summary.status, 'committed');
  assert.equal(result.summary.model_calls, 3);
  assert.equal(result.summary.child_sessions, 2);
  assert.equal(result.summary.write_attempts, 1);
  assert.equal(result.writes.length, 1);
  assert.equal(result.readbacks[0][0].content, 'new route');
  assert.equal(result.captureAllowed, true);
  assert.equal(result.repeated, true);
});
