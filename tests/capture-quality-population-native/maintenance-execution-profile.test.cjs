const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { captureExecutionProfile, captureCollectionWindow } = require('../../plugin/capture/execution-profile.js');
const { executionProfile, bindExecutionProfile } = require('./execution-profile.cjs');
const { createEvaluation, population } = require('./population.cjs');
const { toy } = require('./evaluation-fixture.cjs');
const { inventory, caseInventory, runLimits, createMeter } = require('./inventory.cjs');
const { createWorkflows } = require('./workflows.cjs');
const { wire } = require('./control.cjs');

test('omitted historical maintenance field round trips without changing descriptor bytes', () => {
  const descriptor = createEvaluation({ ...toy(), captureExecutionMs: 45000 });
  const bytes = JSON.stringify(descriptor);
  assert.equal(Object.hasOwn(descriptor, 'maintenanceExecutionMs'), false);
  assert.equal(JSON.stringify(population(JSON.parse(bytes)).descriptor), bytes);
  assert.equal(executionProfile(descriptor).maintenance_ms, 30000);
  assert.equal(executionProfile(descriptor).id, 'capture-45000ms');
});

for (const maintenanceExecutionMs of [45000, 60000]) test(`explicit maintenance${maintenanceExecutionMs} reserves only additional maintenance time and preserves all other dimensions`, () => {
  const old = population(createEvaluation({ ...toy(), captureExecutionMs: 45000 }));
  const selected = population(createEvaluation({ ...toy(), captureExecutionMs: 45000, maintenanceExecutionMs }));
  const before = inventory(old); const after = inventory(selected);
  assert.equal(selected.descriptor.maintenanceExecutionMs, maintenanceExecutionMs);
  assert.equal(after.execution_profile.maintenance_ms, maintenanceExecutionMs);
  assert.equal(after.execution_profile.capture_ms, 45000);
  assert.notEqual(after.execution_profile.id, before.execution_profile.id);
  assert.equal(Object.isFrozen(after.execution_profile), true);
  assert.equal(after.limits.deadline_ms - before.limits.deadline_ms, maintenanceExecutionMs - 30000);
  assert.deepEqual({ ...after.limits, deadline_ms: before.limits.deadline_ms }, before.limits);
  assert.equal(caseInventory('toy-read', selected).deadline_ms, caseInventory('toy-read', old).deadline_ms);
  assert.equal(runLimits(selected).deadline_ms, after.limits.deadline_ms);
  assert.deepEqual(captureCollectionWindow(after.execution_profile, true), maintenanceExecutionMs === 60000
    ? { execution_ms: 105000, inner_ms: 108000, outer_ms: 111000 } : { execution_ms: 90000, inner_ms: 93000, outer_ms: 96000 });
  assert.equal(after.execution_profile.provider_request_ms, 30000);
});

for (const maintenanceExecutionMs of [null, '45000', 0, 30001, 61000]) test(`maintenance rejects ${maintenanceExecutionMs} at descriptor and plugin boundaries`, async () => {
  assert.throws(() => createEvaluation({ ...toy(), maintenanceExecutionMs }), { code: 'maintenance_execution_profile' });
  const { memocap } = await import('../../plugin/cli.js');
  await assert.rejects(memocap({}, { maintenanceExecutionMs }), { code: 'maintenance_execution_profile' });
});

test('descriptor, grant and meter reject mismatched maintenance before effects', () => {
  const selected = population(createEvaluation({ ...toy(), maintenanceExecutionMs: 45000 }));
  assert.throws(() => executionProfile(selected, undefined, 30000), { code: 'capture_execution_profile_mismatch' });
  assert.throws(() => bindExecutionProfile({}, {}, selected), { code: 'capture_execution_profile_mismatch' });
  assert.throws(() => bindExecutionProfile({ maintenanceExecutionMs: 30000 }, { maintenanceExecutionMs: 45000 }, selected),
    { code: 'capture_execution_profile_mismatch' });
  assert.throws(() => createMeter({ mode: 'native', maintenanceExecutionMs: 30000 }, 'native', selected),
    { code: 'capture_execution_profile_mismatch' });
  assert.equal(bindExecutionProfile({}, { maintenanceExecutionMs: 45000 }, selected), captureExecutionProfile(30000, 45000));
});

test('maintenance generations share45 seconds, independent of capture and provider30', () => {
  let now = 0;
  const workflows = createWorkflows(() => now, 45000, 45000);
  const active = { root: 'root', user: 'user' };
  const owner = workflows.start(active, 'maintenance', 45000);
  now = 23000; workflows.generation(owner);
  now = 28000; workflows.generation(owner);
  now = 44999; workflows.generation(owner);
  now = 45000;
  assert.throws(() => workflows.dispatch({ ...active, workflow: 'maintenance', session: 'commit' }), { code: 'review_deadline' });
  assert.throws(() => workflows.start(active, 'maintenance', 45000), { code: 'review_execution_rearmed' });
  const capture = workflows.start(active, 'capture', 45000);
  now = 89999; workflows.generation(capture);
  now = 90000; assert.throws(() => workflows.generation(capture), { code: 'review_deadline' });
});

for (const maintenanceExecutionMs of [45000, 60000]) test(`maintenance${maintenanceExecutionMs} control collection uses selected sum plus existing pads`, async () => {
  let deadline; let end; const request = new EventEmitter();
  request.setTimeout = (value) => { deadline = value; }; request.end = () => end();
  const send = (_options, receive) => { end = () => receive({ statusCode: 200,
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } }); return request; };
  await wire('/inert', 'inert', send, 45000, maintenanceExecutionMs)('/next');
  assert.equal(deadline, maintenanceExecutionMs === 60000 ? 111000 : 96000);
});
