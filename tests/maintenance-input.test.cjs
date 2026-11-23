const assert = require('node:assert/strict');
const test = require('node:test');

test('native child input rejects combined system and accumulated message bytes', async () => {
  const { createMaintenanceInputGuard } = await import('../plugin/maintenance/input.js');
  const turn = {};
  const tasks = { workers: new Map([['child', { turn }]]), check() {}, invalidate(target, reason) { target.reason = reason; } };
  const guard = createMaintenanceInputGuard(tasks);
  guard.messages({ messages: [{ info: { sessionID: 'child' }, parts: [{ type: 'text', text: 'x'.repeat(30000) }] }] });
  assert.throws(() => guard.system({ sessionID: 'child' }, { system: ['y'.repeat(30000)] }), { code: 'input_budget' });
  assert.equal(turn.reason, 'input_budget');
});

test('native input guard leaves parent and other worker sessions alone', async () => {
  const { createMaintenanceInputGuard } = await import('../plugin/maintenance/input.js');
  const tasks = { workers: new Map(), check() { assert.fail('foreign task checked'); }, invalidate() { assert.fail('foreign task invalidated'); } };
  const guard = createMaintenanceInputGuard(tasks);
  const messages = { messages: [{ info: { sessionID: 'parent' }, parts: [{ type: 'text', text: 'x'.repeat(70000) }] }] };
  assert.doesNotThrow(() => guard.messages(messages));
  assert.doesNotThrow(() => guard.system({ sessionID: 'other-child' }, { system: ['y'.repeat(70000)] }));
  assert.equal(messages.messages[0].parts[0].text.length, 70000);
});

for (const surface of ['system', 'messages', 'split-messages', 'split-surfaces']) {
  test(`native ${surface} secret rejects the entire maintenance task`, async () => {
    const { createMaintenanceInputGuard } = await import('../plugin/maintenance/input.js');
    const turn = {};
    const tasks = { workers: new Map([['child', { turn }]]), check() {}, invalidate(target, reason) { target.reason = reason; } };
    const guard = createMaintenanceInputGuard(tasks);
    const messages = (texts) => ({ messages: texts.map((text) => ({ info: { sessionID: 'child' }, parts: [{ type: 'text', text }] })) });
    assert.throws(() => {
      if (surface === 'system') guard.system({ sessionID: 'child' }, { system: ['password=fixture-only'] });
      if (surface === 'messages') guard.messages(messages(['password=fixture-only']));
      if (surface === 'split-messages') guard.messages(messages(['pass', 'word=fixture-only']));
      if (surface === 'split-surfaces') {
        guard.system({ sessionID: 'child' }, { system: ['pass'] });
        guard.messages(messages(['word=fixture-only']));
      }
    }, { code: 'sensitive_input' });
    assert.equal(turn.reason, 'sensitive_input');
  });
}
