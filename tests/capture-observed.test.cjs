const assert = require('node:assert/strict');
const test = require('node:test');

const user = (id = 'u', text = 'Use concise Chinese.') => ({ message: { id, sessionID: 'parent', role: 'user' },
  parts: [{ id: `text_${id}`, type: 'text', text }] });
const assistant = (extra = {}) => ({ id: 'a', sessionID: 'parent', role: 'assistant', parentID: 'u',
  time: { created: 1, completed: 2 }, finish: 'stop', ...extra });
const info = (cache, value) => cache.event({ type: 'message.updated', properties: { info: value } });
const part = (cache, value) => cache.event({ type: 'message.part.updated', properties: { part: {
  sessionID: 'parent', messageID: 'a', ...value,
} } });
const tool = (output, status = 'completed') => ({ id: 'read', type: 'tool', tool: 'read', callID: 'call',
  state: { status, time: { start: 1, end: 2 }, input: { filePath: '/project/docs/route.md' }, output } });

for (const flags of [{ synthetic: true }, { ignored: true }, { metadata: { memocap: true } }]) {
  test(`retracts user evidence when classified ${Object.keys(flags)[0]}`, async (t) => {
    const current = await cache(t);
    part(current, { messageID: 'u', ...user().parts[0], ...flags });
    assert.deepEqual(current.snapshot('parent', 'u')[0].parts, []);
  });
  test(`late clean text cannot revive ${Object.keys(flags)[0]} user evidence`, async (t) => {
    const current = await cache(t);
    part(current, { messageID: 'u', ...user().parts[0], ...flags });
    part(current, { messageID: 'u', ...user().parts[0] });
    assert.deepEqual(current.snapshot('parent', 'u')[0].parts, []);
  });
}

for (const [version, reason, expectedChildren] of [
  ['1.19.3', 'no_candidate', 1], ['1.20.0', 'no_candidate', 1],
  ['2.0.0', 'host_version', 0], ['1.20', 'host_version', 0],
]) test(`capture only uses hook-observed parent parts and gates child sessions for host ${version}`, async (t) => {
  const { createCapture } = await import('../plugin/capture/index.js');
  const messages = [{ info: user().message, parts: user().parts }, { info: assistant(), parts: [] }];
  const histories = [];
  let childCount = 0;
  const permissionChecks = [];
  const reviewed = Promise.withResolvers();
  const state = { generation: 1, targets: [{ repository_id: 'repository:fixture' }] };
  let capture;
  const input = { client: { _client: { get: async () => ({ data: { healthy: true, version } }) },
    tool: { ids: async () => ({ data: ['memocap_remember'] }) }, session: {
    get: async () => ({ data: {} }), messages: async (request) => { histories.push(request); return { data: messages }; },
    create: async () => { childCount++; return { data: { id: 'extract' } }; }, abort: async () => ({ data: true }),
    prompt: async () => {
      capture.observe({ sessionID: 'extract', agent: 'build' }, user('worker'));
      capture.event({ event: { type: 'message.updated', properties: { info: assistant({ sessionID: 'extract', parentID: 'worker' }) } } });
      capture.event({ event: { type: 'session.status', properties: { sessionID: 'extract', status: { type: 'idle' } } } });
      capture.params({ sessionID: 'extract' }, {}); return { data: {
      info: { finish: 'stop' }, parts: [{ type: 'text', text: '{"candidates":[]}' }],
    } }; },
  } } };
  const runtime = { warnings: [], context: async () => state, readPermission: { check: async (caller) => { permissionChecks.push(caller); } },
    request: async (_state, args) => { reviewed.resolve(JSON.parse(args.at(-1))); return {}; } };
  capture = createCapture(input, runtime, {});
  t.after(() => capture.dispose());
  capture.observe({ sessionID: 'parent', agent: 'build', model: { providerID: 'wire', modelID: 'wire' } }, user());
  capture.event({ event: { type: 'message.updated', properties: { info: assistant() } } });
  capture.event({ event: { type: 'session.status', properties: { sessionID: 'parent', status: { type: 'idle' } } } });
  const review = await reviewed.promise;
  assert.equal(review.detail.metadata.reason, reason);
  assert.equal(histories.length, 0);
  assert.equal(childCount, expectedChildren);
  assert.deepEqual(permissionChecks, expectedChildren ? [{ sessionID: 'parent', agent: 'build' }] : []);
});

async function cache(t, options) {
  const value = (await import('../plugin/capture/observed.js')).createObserved(options);
  t.after(() => value.dispose());
  value.observe({ sessionID: 'parent' }, user());
  info(value, assistant());
  return value;
}

for (const change of [
  (value) => { value.state.output = 'Authorization:\nBearer synthetic-value'; },
  (value) => { value.state.input.token = 'synthetic-value'; },
  (value) => { value.metadata = { nested: { value: 'api_key: synthetic-value' } }; },
  (value) => { value.state.output = '\ud800'; },
]) {
  test('screens the entire observed unit before retaining body or dependencies', async (t) => {
    const current = await cache(t);
    const value = tool('Start at docs/alpha.md.');
    change(value);
    part(current, value);
    const retained = current.snapshot('parent', 'u').at(-1).parts[0];
    assert.deepEqual(retained, { id: 'read', type: 'tool', state: { status: 'completed', time: { start: 1, end: 2 } } });
  });
}

test('omits oversized body and untrusted metadata while preserving actual completion fields', async (t) => {
  const current = await cache(t, { profile: { partBytes: 256 } });
  info(current, assistant({ agent: 'x'.repeat(20000), error: undefined }));
  part(current, { ...tool('x'.repeat(20000)), metadata: { title: 'untrusted' } });
  const result = current.snapshot('parent', 'u');
  assert.deepEqual(result.at(-1).info, { id: 'a', role: 'assistant', parentID: 'u', time: { created: 1, completed: 2 }, finish: 'stop' });
  assert.deepEqual(result.at(-1).parts[0], { id: 'read', type: 'tool', state: { status: 'completed', time: { start: 1, end: 2 } } });
  assert.equal((await import('../plugin/capture/contract.js')).complete(result, 'u'), true);
});

test('does not rehydrate a rejected unit from a later clean update', async (t) => {
  const current = await cache(t);
  part(current, tool('token: synthetic-value', 'running'));
  part(current, tool('Start at docs/alpha.md.'));
  assert.equal(current.snapshot('parent', 'u').at(-1).parts[0].state.output, undefined);
});

test('an older secret-bearing update revokes retained tool body without reviving running state', async (t) => {
  const current = await cache(t);
  part(current, tool('Start at docs/alpha.md.'));
  part(current, tool('token: synthetic-value', 'running'));
  const retained = current.snapshot('parent', 'u').at(-1).parts[0];
  assert.equal(retained.state.output, undefined);
  assert.equal(retained.state.status, 'completed');
});

test('an observed message error cannot disappear under a later stale clean info event', async (t) => {
  const current = await cache(t);
  info(current, assistant({ error: { message: 'token: synthetic-value' } }));
  info(current, assistant());
  assert.equal((await import('../plugin/capture/contract.js')).complete(current.snapshot('parent', 'u'), 'u'), false);
});

test('terminal tool and message events survive older running events without combining incomplete info', async (t) => {
  const current = await cache(t);
  part(current, tool('Start at docs/alpha.md.'));
  part(current, tool(undefined, 'running'));
  info(current, assistant({ finish: undefined, time: { created: 1 } }));
  const { complete } = await import('../plugin/capture/contract.js');
  assert.equal(complete(current.snapshot('parent', 'u'), 'u'), true);
  info(current, assistant({ id: 'b', time: { created: 3 }, finish: 'stop' }));
  info(current, assistant({ id: 'b', time: { created: 3, completed: 4 }, finish: undefined }));
  assert.equal(complete(current.snapshot('parent', 'u'), 'u'), false);
});

test('parts preceding message info retain only completion metadata and unknown info blocks completion', async (t) => {
  const current = await cache(t);
  part(current, { ...tool('Start at docs/alpha.md.'), messageID: 'b' });
  assert.deepEqual(current.snapshot('parent', 'u'), []);
  info(current, assistant({ id: 'b', time: { created: 3, completed: 4 } }));
  assert.equal(current.snapshot('parent', 'u').at(-1).parts[0].state.output, undefined);
  assert.equal((await import('../plugin/capture/contract.js')).complete(current.snapshot('parent', 'u'), 'u'), true);
});

test('synthetic and foreign observations cannot populate evidence or revive old user snapshots', async (t) => {
  const current = await cache(t);
  current.observe({ sessionID: 'other' }, { ...user('fake'), parts: [{ id: 'synthetic', type: 'text', text: 'Synthetic.', synthetic: true }] });
  info(current, assistant({ id: 'foreign', parentID: 'other' }));
  part(current, { ...tool('Foreign.'), messageID: 'foreign' });
  info(current, assistant({ id: 'foreign', parentID: 'other' }));
  assert.equal(current.snapshot('parent', 'u').length, 2);
  assert.deepEqual(current.snapshot('other', 'fake'), []);
  current.observe({ sessionID: 'parent' }, user('new'));
  assert.deepEqual(current.snapshot('parent', 'u'), []);
  assert.equal(current.snapshot('parent', 'new')[0].info.id, 'new');
});

test('configured session and turn limits evict whole observations', async (t) => {
  const current = await cache(t, { profile: { sessions: 2, turns: 2 } });
  for (let index = 0; index < 10; index++) current.observe({ sessionID: `session_${index}` }, user(`u_${index}`));
  for (let index = 0; index < 10; index++) current.observe({ sessionID: 'parent' }, user(`new_${index}`));
  assert.equal(current.stats().sessions, 2);
  assert.equal(current.stats().turns, 3);
  assert.deepEqual(current.snapshot('session_0', 'u_0'), []);
  assert.deepEqual(current.snapshot('parent', 'new_8'), []);
});

for (const [field, maximum] of [['parts', 1], ['messages', 1], ['turnBytes', 256], ['globalBytes', 256]]) {
  test(`${field} overflow fails closed instead of losing an unfinished constraint`, async (t) => {
    const current = await cache(t, { profile: { [field]: maximum } });
    part(current, tool('x'.repeat(400)));
    part(current, { ...tool('Start at docs/alpha.md.'), id: 'another' });
    assert.equal((await import('../plugin/capture/contract.js')).complete(current.snapshot('parent', 'u'), 'u'), false);
    assert.ok(current.stats().bytes <= current.profile.globalBytes);
  });
}

test('injected clock expires retained data without further host activity and dispose cancels its timer', async (t) => {
  let now = 100;
  const timers = new Map();
  const clock = { now: () => now, setTimeout: (fn) => { const id = Symbol(); timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id) };
  const current = await cache(t, { clock, profile: { ttlMs: 10 } });
  now = 111;
  timers.values().next().value();
  assert.equal(current.stats().turns, 0);
  assert.equal(timers.size, 0);
  current.dispose();
  current.observe({ sessionID: 'parent' }, user());
  assert.equal(current.stats().turns, 0);
});

for (const type of ['session.error', 'session.deleted', 'message.removed', 'message.part.removed']) {
  test(`${type} clears every retained observation`, async (t) => {
    const current = await cache(t);
    current.event({ type, properties: { sessionID: 'parent' } });
    assert.deepEqual(current.snapshot('parent', 'u'), []);
    assert.equal(current.stats().turns, 0);
  });
}

test('a stale worker failure cannot clear observations for a newer real user turn', async (t) => {
  const current = await cache(t);
  current.observe({ sessionID: 'parent' }, user('fresh'));
  current.clear('parent', 'u');
  assert.equal(current.snapshot('parent', 'fresh')[0]?.info.id, 'fresh');
  current.clear('parent', 'fresh');
  assert.equal(current.stats().turns, 0);
});

test('secret user bodies never enter a retained snapshot and returned snapshots cannot mutate retained data', async (t) => {
  const current = await cache(t);
  current.observe({ sessionID: 'parent' }, user('secret', 'token: synthetic-value'));
  assert.deepEqual(current.snapshot('parent', 'secret')[0].parts, []);
  current.observe({ sessionID: 'parent' }, user('fresh'));
  const output = current.snapshot('parent', 'fresh');
  output[0].parts[0].text = 'token: mutated-value';
  assert.equal(current.snapshot('parent', 'fresh')[0].parts[0].text, 'Use concise Chinese.');
});

test('secrets split across real user text parts are screened as a whole message before retention', async (t) => {
  const current = await cache(t);
  current.observe({ sessionID: 'parent' }, { message: user('split').message, parts: [
    { id: 'prefix', type: 'text', text: 'api_' }, { id: 'suffix', type: 'text', text: 'key: synthetic-value' },
  ] });
  assert.deepEqual(current.snapshot('parent', 'split')[0].parts, []);
});

test('a later user part cannot complete a secret across retained fragments', async (t) => {
  const current = await cache(t);
  current.observe({ sessionID: 'parent' }, user('later', 'api_'));
  part(current, { messageID: 'later', id: 'suffix', type: 'text', text: 'key: synthetic-value' });
  assert.deepEqual(current.snapshot('parent', 'later')[0].parts, []);
});

for (const profile of [{ turns: 0 }, { partBytes: Infinity }, { unknown: 1 }, { ttlMs: 2147483648 }]) {
  test('invalid bounds are rejected before observations can be retained', async () => {
    const { createObserved } = await import('../plugin/capture/observed.js');
    assert.throws(() => createObserved({ profile }), { code: 'observed_profile' });
  });
}
