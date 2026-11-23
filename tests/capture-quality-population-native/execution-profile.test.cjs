const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createEvaluation, population } = require('./population.cjs');
const { toy } = require('./evaluation-fixture.cjs');
const { caseInventory, inventory, runLimits } = require('./inventory.cjs');
const { createWorkflows } = require('./workflows.cjs');
const { wire } = require('./control.cjs');

for (const captureExecutionMs of [30000, 45000, 60000]) {
  test(`${captureExecutionMs} public workflow enforces one execution window`, () => {
    let now = 40000;
    const workflows = createWorkflows(() => now, captureExecutionMs);
    const owner = workflows.child({ root: 'root', user: 'user' }, 'memocap capture extract');

    workflows.generation(owner); now += captureExecutionMs - 1;
    workflows.generation(owner); now++;

    assert.throws(() => workflows.generation(owner), { code: 'review_deadline' });
    assert.equal(owner.generations, 2);
  });
  test(`${captureExecutionMs} public descriptor reserves full outer collection`, () => {
    const selected = population(createEvaluation({ ...toy(), captureExecutionMs }));

    const actual = caseInventory('toy-read', selected);
    const full = caseInventory('same-task-third-turn', undefined, captureExecutionMs);

    assert.equal(actual.deadline_ms, 30000 + captureExecutionMs + 6000 + 33000);
    assert.equal(full.deadline_ms, { 30000: 231000, 45000: 276000, 60000: 321000 }[captureExecutionMs]);
    assert.equal(inventory(selected).execution_profile.capture_ms, captureExecutionMs);
    assert.equal(runLimits(selected).deadline_ms, inventory(selected).limits.deadline_ms);
  });
  test(`${captureExecutionMs} control RPC holds through full combined collection`, async () => {
    let deadline; let end; const request = new EventEmitter();
    request.setTimeout = (value) => { deadline = value; }; request.end = () => end();
    const send = (_options, receive) => { end = () => receive({ statusCode: 200,
      async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } }); return request; };

    await wire('/inert', 'inert', send, captureExecutionMs)('/next');

    assert.equal(deadline, captureExecutionMs + 30000 + 6000);
  });
}
for (const captureExecutionMs of [null, 0, 30001, 65000, '45000']) test(`public descriptor refuses invalid profile ${captureExecutionMs}`, () => {
  assert.throws(() => createEvaluation({ ...toy(), captureExecutionMs }), { code: 'capture_execution_profile' });
});
