const assert = require('node:assert/strict');
const test = require('node:test');
const { captureDone } = require('./maintenance-integration/host.cjs');

test('maintenance capture completion selects the native close for the exact session review', async () => {
  const record = (session_id, phase = 'capture_review') => ['activity', 'record', '--payload', JSON.stringify({
    context: { session_id }, detail: { phase },
  })];
  const args = record('parent');
  const finished = { phase: 'native.finished', args, code: 0 };
  const events = [
    { phase: 'native.spawn', args },
    { phase: 'native.finished', args: record('foreign'), code: 0 },
    { phase: 'native.finished', args: record('parent', 'recall'), code: 0 },
    finished,
  ];
  const control = { wait: async (predicate) => events.find(predicate) };

  assert.equal(await captureDone(control, { id: 'parent' }), finished);
});
