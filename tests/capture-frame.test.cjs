const test = require('node:test');
const assert = require('node:assert/strict');
const { readObservation } = require('./capture-source-host/synthetic.cjs');

test('retains verified bounded metadata and quarantines completed frames under exact frozen origin', async (t) => {
  const { createObserved } = await import('../plugin/capture/observed.js');
  const cache = createObserved();
  t.after(() => cache.dispose());
  cache.observe({ sessionID: 'parent' }, { message: { id: 'user', role: 'user' }, parts: [{ id: 'p', type: 'text', text: 'Verify alpha route.' }] });
  cache.event({ type: 'message.updated', properties: { info: { id: 'message', sessionID: 'parent', role: 'assistant', parentID: 'user', time: { created: 1, completed: 3 }, finish: 'stop' } } });
  const observation = readObservation();
  cache.event({ type: 'message.part.updated', properties: { part: { ...observation.part, sessionID: 'parent' } } });
  cache.bind('parent', 'user', 'origin-A');
  cache.observe({ sessionID: 'parent' }, { message: { id: 'next', role: 'user' }, parts: [{ id: 'nextp', type: 'text', text: 'Continue verification of alpha.' }] });
  const frame = cache.frame('parent', 'next', 'origin-A');
  assert.equal(frame.length, 2);
  assert.deepEqual(frame[0].messages.at(-1).parts[0].state.metadata, observation.part.state.metadata);
  assert.equal(frame[0].userID, 'user');
  assert.equal(cache.frame('parent', 'next', 'origin-B').length, 1);
});

test('terminal tool error permits a later independent result while assistant error blocks completion', async () => {
  const { complete } = await import('../plugin/capture/contract.js');
  const messages = [{ info: { id: 'u', role: 'user' }, parts: [] }, { info: { id: 'a', role: 'assistant', parentID: 'u', time: { completed: 3 }, finish: 'stop' },
    parts: [{ type: 'tool', state: { status: 'error' } }, { type: 'tool', state: { status: 'completed' } }] }];
  assert.equal(complete(messages, 'u'), true);
  messages[1].info.error = true;
  assert.equal(complete(messages, 'u'), false);
});
