const assert = require('node:assert/strict');
const test = require('node:test');
const { pendingProbe } = require('./pending-lifecycle-probe.cjs');

for (const workflow of ['capture', 'scheduler', 'maintenance']) {
  for (const phase of ['review.started', 'review.finished', ...(workflow === 'capture' ? [] : ['maintenance.review'])]) {
    for (const action of ['timeout', 'new_input', 'cancel', 'dispose']) {
      for (const late of ['resolve', 'reject']) test(`${workflow} pending ${phase} settles on ${action} before late ${late}`, async (context) => {
        const current = await pendingProbe(context, { workflow, phase });
        await current.stop(action);
        const before = current.snapshot();
        try {
          assert.equal(before.settled, true, JSON.stringify(before));
          assert.equal(before.review_timers, 0);
          if (action === 'dispose') assert.equal(before.disposed, true);
          else {
            assert.equal(before.summary.write_attempts, 0);
            assert.equal(before.summary.observation_warning, `${workflow === 'capture' ? 'capture' : 'maintenance'}_observation_failed`);
          }
          if (workflow === 'scheduler') {
            assert.equal(before.jobs, 0); assert.equal(before.workers, 0); assert.equal(before.evidence, 0); assert.equal(before.used, 0);
            assert.deepEqual(before.cleaned, ['abort', 'delete']);
            assert.equal(before.listeners, 0);
            assert.equal(before.reviews, phase === 'review.started' ? 0 : 1);
          }
          if (phase === 'review.started' && action !== 'dispose') {
            assert.equal(before.summary.status, workflow === 'capture' ? 'failed' : 'blocked');
            assert.equal(before.summary.reason, action === 'timeout' ? `${workflow === 'capture' ? 'capture' : 'maintenance'}_timeout`
              : action === 'new_input' ? 'new_input' : workflow === 'capture' ? 'parent_error' : 'parent_signal');
          }
          await current.dispose();
          assert.equal(current.snapshot().disposed, true);
          assert.equal(current.snapshot().timers, 0);
          const disposedBeforeLate = current.snapshot();
          if (late === 'resolve') current.gate.resolve(); else current.gate.reject(new Error('late observer rejection'));
          await current.pump();
          assert.deepEqual(current.snapshot(), disposedBeforeLate, 'late callback cannot revive or duplicate review');
          current.advance(65001);
          await current.pump();
          assert.deepEqual(current.snapshot(), { ...disposedBeforeLate, now: disposedBeforeLate.now + 65001 });
          if (action === 'timeout' && late === 'resolve') context.diagnostic(JSON.stringify({ workflow, phase, action, late, at_settlement: before, after_dispose: current.snapshot() }));
        } finally { current.gate.resolve(); }
      });
    }
  }
}

for (const workflow of ['capture', 'scheduler', 'maintenance']) test(`${workflow} callback abort before listener registration prevents work`, async (context) => {
  const current = await pendingProbe(context, { workflow, phase: 'review.started', abortInside: true });
  await current.pump();
  assert.equal(current.snapshot().settled, true);
  assert.equal(current.snapshot().summary.write_attempts, 0);
  assert.equal(current.snapshot().summary.reason, workflow === 'capture' ? 'parent_error' : 'parent_signal');
  current.gate.reject(new Error('already aborted late rejection'));
  await current.pump();
  assert.equal(current.snapshot().review_timers, 0);
});
