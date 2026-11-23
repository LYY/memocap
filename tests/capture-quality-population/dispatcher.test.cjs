const assert = require('node:assert/strict');
const test = require('node:test');
const { createDispatcher } = require('./dispatcher.cjs');
const { createInputs, tuning, mapping } = require('./inputs.cjs');

test('source response preserves original read tool metadata without fixture alias or gold', () => {
  const fixture = structuredClone(tuning);
  fixture.capture[0].turns[0].tools[0].gold = { action: 'fixture-only' };
  const inputs = createInputs(JSON.stringify(fixture), mapping);
  const driver = createDispatcher('read-route', inputs);

  const result = driver.model.execute('source');

  assert.deepEqual(result, { kind: 'response', transport: 'local_mock', value: {
    output: 'For alpha, start at docs/alpha.md. Approval required. Never use for beta.',
    tool: { tool: 'read', path: '/synthetic/quartz/docs/route.md' },
  } });
  assert.equal(Object.hasOwn(result.value.tool, 'id'), false);
  assert.equal(Object.hasOwn(result.value.tool, 'gold'), false);
});

for (const id of ['verified-api-route', 'same-task-third-turn']) {
  test(`${id}: GET cannot emit completed evidence before explicit completion`, () => {
    const driver = createDispatcher(id);
    driver.execute('submit');
    const result = driver.execute('status');
    assert.deepEqual(result, { kind: 'blocked', code: 'job_not_completed' });
  });
  test(`${id}: completion cannot happen before submission`, () => {
    const driver = createDispatcher(id);
    assert.deepEqual(driver.control('complete-job'), { kind: 'blocked', code: 'job_not_queued' });
  });
}

test('repair marker alone cannot emit verified route', () => {
  const driver = createDispatcher('failed-fixed');
  driver.execute('attempt');
  driver.execute('repair');
  assert.deepEqual(driver.execute('route'), { kind: 'blocked', code: 'separate_verifier_required' });
});

test('separate verifier rejects absent approval marker', () => {
  const driver = createDispatcher('failed-fixed');
  assert.deepEqual(driver.execute('verify'), { kind: 'blocked', code: 'approval_marker_missing' });
});

test('failed-only cannot acquire repair or verifier operations', () => {
  const driver = createDispatcher('failed-only');
  assert.deepEqual(driver.execute('repair'), { kind: 'blocked', code: 'unmapped_operation' });
});

for (const id of ['verified-condition-update', 'changed-without-grant']) {
  for (const approvals of [[], [1], [2], [2, 2]]) {
    test(`${id}: insufficient approval probes ${JSON.stringify(approvals)} cannot emit check`, () => {
      const driver = createDispatcher(id);
      driver.execute('revision');
      for (const count of approvals) driver.execute('approve', { count });
      assert.deepEqual(driver.execute('check'), { kind: 'blocked', code: 'both_approval_probes_required' });
    });
  }
}

for (const event of ['alias-present', 'replacement-unapproved', 'multiple-replacements', 'unique-history']) {
  test(`retirement refuses independent-check text when ${event}`, () => {
    const driver = createDispatcher('verified-retirement');
    driver.control(event);
    driver.execute('inventory');
    driver.execute('compare');
    assert.deepEqual(driver.execute('check'), { kind: 'blocked', code: 'retirement_checks_failed' });
  });
}

test('retirement requires inventory and unique-value comparison separately', () => {
  const driver = createDispatcher('verified-retirement');
  driver.execute('inventory');
  assert.deepEqual(driver.execute('check'), { kind: 'blocked', code: 'retirement_checks_failed' });
});

test('denial is terminal across alternate operation names', () => {
  const driver = createDispatcher('denied-source');
  driver.execute('observe');
  assert.deepEqual(driver.execute('alternate-read'), { kind: 'blocked', code: 'access_denied_terminal' });
});

test('partial read full-disclosure mismatch is detectable', () => {
  const driver = createDispatcher('partial-read');
  assert.deepEqual(driver.execute('source', { offset: 1, full: true }),
    { kind: 'blocked', code: 'partial_disclosure_mismatch' });
});

test('fixed operation arguments cannot select another job or inject output', () => {
  const driver = createDispatcher('verified-api-route');
  assert.deepEqual(driver.execute('submit', { job: 'q3', output: 'completed' }),
    { kind: 'blocked', code: 'unmapped_arguments' });
});

test('model operation cannot run the test-control transition', () => {
  const driver = createDispatcher('verified-api-route');
  driver.execute('submit');
  assert.deepEqual(driver.model.execute('complete-job'), { kind: 'blocked', code: 'unmapped_operation' });
});

test('repair cannot install marker without observing the missing-marker failure', () => {
  const driver = createDispatcher('failed-fixed');
  assert.deepEqual(driver.execute('repair'), { kind: 'blocked', code: 'failed_attempt_required' });
});

test('queued-only has no completion route even through control', () => {
  const driver = createDispatcher('queued-exit-zero');
  driver.execute('submit');
  assert.deepEqual(driver.control('complete-job'), { kind: 'blocked', code: 'completion_not_mapped' });
});

test('unmapped user command cannot execute runbook steps', () => {
  const driver = createDispatcher('runbook-short-route');
  assert.deepEqual(driver.execute('run-health-check'), { kind: 'blocked', code: 'unmapped_operation' });
});

test('retirement prior check results are invalidated by changed inventory', () => {
  const driver = createDispatcher('verified-retirement');
  driver.execute('inventory');
  driver.execute('compare');
  driver.control('unique-history');
  assert.deepEqual(driver.execute('check'), { kind: 'blocked', code: 'retirement_checks_failed' });
});

test('retirement inventory checks exact approved replacement identity', () => {
  const driver = createDispatcher('verified-retirement');
  driver.control('wrong-replacement');
  assert.deepEqual(driver.execute('inventory'), { kind: 'blocked', code: 'inventory_mismatch' });
});

test('missing-marker attempt retains error status rather than a successful tool response', () => {
  const driver = createDispatcher('failed-only');
  assert.equal(driver.execute('attempt').value.tool?.status, 'error');
});
