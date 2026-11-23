const assert = require('node:assert/strict');
const test = require('node:test');
const frameTurn = (parentID, prior) => ({ task: { parentID }, origin: 'frozen', prior, used: [{ use_id: 'actual-adoption' }],
  evidence: new Map([['evidence', { text: 'observed source' }]]) });
test('maintenance frame expiry is measured from original observation with an injected clock', async () => {
  const { createMaintenanceFrames } = await import('../plugin/maintenance/continuity.js');
  let now = 0;
  const frames = createMaintenanceFrames({ clock: () => now });
  frames.save(frameTurn('A'), { status: 'no_candidate' });
  now = 299999;
  const prior = frames.take('A');
  frames.save(frameTurn('A', prior), { status: 'no_candidate' });
  now = 300000;
  assert.equal(frames.take('A'), undefined);
});
test('maintenance frame turn and global byte bounds evict whole observations', async () => {
  const { createMaintenanceFrames } = await import('../plugin/maintenance/continuity.js');
  const frames = createMaintenanceFrames();
  let prior;
  for (let index = 0; index < 4; index++) {
    frames.save(frameTurn('A', prior), { status: 'no_candidate' });
    prior = frames.take('A');
  }
  assert.equal(prior, undefined);
  for (let index = 0; index < 80; index++) {
    const turn = frameTurn(`parent-${index}`);
    turn.evidence.set('large', { text: 'x'.repeat(30000) });
    frames.save(turn, { status: 'no_candidate' });
  }
  assert.ok(frames.stats().entries < 64);
  assert.ok(frames.stats().bytes <= 1048576);
  assert.equal(frames.take('parent-0'), undefined);
  assert.equal(frames.take('parent-79').evidence[1].text.length, 30000);
});
for (const status of ['unknown', 'blocked', 'denied', 'committed']) test(`maintenance ${status} outcome clears prior eligibility`, async () => {
  const { createMaintenanceFrames } = await import('../plugin/maintenance/continuity.js');
  const frames = createMaintenanceFrames();
  frames.save(frameTurn('A'), { status });
  assert.equal(frames.take('A'), undefined);
});
