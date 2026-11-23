const assert = require('node:assert/strict');
const test = require('node:test');
const { runCase } = require('./adapter.cjs');
const { sdkHost } = require('./sdk-host.cjs');
const { fakeHost } = require('./fake-host.cjs');
const { toy, digest } = require('./evaluation-fixture.cjs');
const { createEvaluation } = require('./population.cjs');

function sdkHarness(prompt, autoUser = true) {
  let packet; let boundary;
  const events = [];
  const host = sdkHost({ sdk: { session: {
    create: async () => ({ data: { id: 'root' } }),
    prompt: async (request) => {
      const user = (text = packet.user) => boundary.user({ message: { id: 'user', sessionID: 'root', role: 'user' }, parts: [
        { id: 'user-part', sessionID: 'root', messageID: 'user', type: 'text', text }] });
      if (autoUser) user();
      return prompt({ boundary, request, events, user });
    },
  } }, approval: { approved: true, approval_id: undefined },
  location: { origin: 'repository:offline', version: '1.19.3' }, seed: async () => {},
  link: { install: async () => ({ dispose() {} , state: () => ({ children: [] }) }),
    bind: async (nextPacket, nextBoundary) => { packet = nextPacket; boundary = nextBoundary; },
    wait: async () => { events.push('settle'); return { status: 'no_candidate' }; } },
  close: async () => { events.push('close'); return { exited: true, children: 0, removed: true }; } });
  host.mode = 'offline';
  return { host, events };
}

const stop = { id: 'assistant', sessionID: 'root', parentID: 'user', role: 'assistant', finish: 'stop', time: { completed: 3 } };

const syntheticUsers = ['Start the toy task.', 'Continue the toy task.', 'Finish the toy task.'];
const syntheticSdkError = { error: { name: 'fixture-error', body: 'synthetic private response body' } };
const sdkErrorSummary = { error: 'sdk_error', finish: 'unrecognized_or_absent', part_types: [] };

for (const { name, response, reason, evidence, rejectsUser } of [
  { name: 'SDK error without a user callback', response: syntheticSdkError, reason: 'native_prompt_error',
    evidence: { native_user_observed: false, failure_origin: 'sdk.response', sdk: sdkErrorSummary } },
  { name: 'SDK success without a user callback', response: { data: { info: stop, parts: [] } }, reason: 'native_user_missing',
    evidence: { native_user_observed: false, sdk: { error: 'none', finish: 'stop', part_types: [] } } },
  { name: 'SDK error after rejected callbacks', response: syntheticSdkError, reason: 'native_user_mismatch', rejectsUser: true,
    evidence: { failure_origin: 'boundary.user', sdk: sdkErrorSummary } },
]) test(`synthetic second turn: ${name} blocks further work and closes`, async () => {
  const input = toy();
  const raw = JSON.parse(input.input_utf8);
  raw.capture[0].turns = syntheticUsers.map((user) => ({ user, tools: [] }));
  Object.assign(input.mapping.cases[0], { operations: {}, script: [] });
  input.input_utf8 = JSON.stringify(raw);
  input.input_sha256 = input.mapping.tuning_sha256 = digest(input.input_utf8);
  input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  const population = createEvaluation(input);
  const { host, events } = sdkHarness(({ boundary, request, events, user }) => {
    const text = request.body.parts[0].text;
    events.push(text);
    if (text === syntheticUsers[0]) {
      user();
      boundary.complete(stop);
      return { data: { info: stop, parts: [] } };
    }
    if (rejectsUser) {
      assert.throws(() => user('Mismatched toy input.'), /native_user_mismatch/);
      assert.throws(() => boundary.complete(stop), /native_completion_missing/);
    }
    return response;
  }, false);
  const result = await runCase('toy-read', { host, population, budget: { mode: 'offline' } });
  assert.deepEqual(events, [syntheticUsers[0], 'settle', syntheticUsers[1], 'close']);
  assert.deepEqual(result.cleanup, { exited: true, children: 0, removed: true });
  assert.deepEqual(result.turns.map(({ turn }) => turn), [1]);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, reason);
  assert.deepEqual(result.completion_evidence.at(-1), { turn: 2, ...evidence });
});

test('joins a valid stop arriving after the SDK prompt returns', async () => {
  const consumed = Promise.withResolvers();
  const release = Promise.withResolvers();
  let arrival;
  const { host, events } = sdkHarness(({ boundary }) => {
    arrival = release.promise.then(() => { events.push('complete'); boundary.complete(stop); });
    return { data: { info: stop, parts: [] }, get error() { consumed.resolve(); return undefined; } };
  });
  const running = runCase('unicode-preference', { host, budget: { mode: 'offline', approved: false } });
  await consumed.promise;
  await new Promise(setImmediate);
  release.resolve();
  const result = await running;
  await arrival;
  assert.equal(result.status, 'wired', result.reason);
  assert.equal(result.custody.at(-1).completion, 'observed_stop');
  assert.deepEqual(events, ['complete', 'settle', 'close']);
});

for (const [name, response, reason, error, finish] of [
  ['SDK error', { error: { name: 'private-provider-detail', body: 'SECRET' } }, 'native_prompt_error', 'sdk_error', 'unrecognized_or_absent'],
  ['assistant error', { data: { info: { ...stop, error: { name: 'private-detail' } } } }, 'native_prompt_error', 'assistant_error', 'stop'],
  ['non-stop', { data: { info: { ...stop, finish: 'length' } } }, 'native_prompt_nonstop', 'none', 'length'],
  ['unknown finish', { data: { info: { ...stop, finish: 'SECRET' } } }, 'native_prompt_nonstop', 'none', 'unrecognized_or_absent'],
]) test(`blocks ${name} without accepting it as a stop`, async () => {
  const { host, events } = sdkHarness(() => response);
  const result = await runCase('unicode-preference', { host, budget: { mode: 'offline', approved: false } });
  assert.equal(result.reason, reason);
  assert.deepEqual(events, ['close']);
  assert.equal(result.custody.some((row) => row.completion), false);
  assert.deepEqual(result.completion_evidence, [{ turn: 1, failure_origin: 'sdk.response', sdk: { error, finish, part_types: [] } }]);
});

test('returns only finite part type categories from the SDK response', async () => {
  const { host } = sdkHarness(({ boundary }) => {
    boundary.complete(stop);
    return { data: { info: stop, parts: [{ type: 'text', text: 'SECRET' }, { type: 'text' }, { type: 'SECRET' }] } };
  });
  const result = await runCase('unicode-preference', { host, budget: { mode: 'offline', approved: false } });
  assert.equal(result.status, 'wired');
  assert.deepEqual(result.completion_evidence, [{ turn: 1, sdk: { finish: 'stop', error: 'none', part_types: ['other', 'text'] } }]);
});

for (const [name, completion] of [
  ['foreign user', { ...stop, parentID: 'foreign' }],
  ['foreign session', { ...stop, sessionID: 'foreign' }],
  ['missing completed time', { ...stop, time: {} }],
  ['error stop', { ...stop, error: { name: 'SECRET' } }],
  ['non-stop callback', { ...stop, finish: 'length' }],
]) test(`retains the boundary failure for a late ${name}`, async () => {
  const release = Promise.withResolvers();
  const started = Promise.withResolvers();
  let arrival;
  const { host, events } = sdkHarness(({ boundary }) => {
    arrival = release.promise.then(() => assert.throws(() => boundary.complete(completion), /native_completion_missing/));
    started.resolve();
    return { data: { info: stop, parts: [] } };
  });
  const running = runCase('unicode-preference', { host, budget: { mode: 'offline', approved: false } });
  await started.promise;
  await new Promise(setImmediate);
  release.resolve();
  const result = await running;
  await arrival;
  assert.equal(result.reason, 'native_completion_missing');
  assert.equal(result.completion_evidence[0].failure_origin, 'boundary.complete');
  assert.deepEqual(events, ['close']);
});

for (const duplicate of [stop, { ...stop, id: 'different' }, { ...stop, time: { completed: 4 } }]) {
  test(`rejects repeated completion ${duplicate.id}/${duplicate.time.completed}`, async () => {
    const { host, events } = sdkHarness(({ boundary }) => {
      boundary.complete(stop);
      assert.throws(() => boundary.complete(duplicate), /native_completion_missing/);
      return { data: { info: stop, parts: [] } };
    });
    const result = await runCase('unicode-preference', { host, budget: { mode: 'offline', approved: false } });
    assert.equal(result.reason, 'native_completion_missing');
    assert.equal(result.custody.filter((row) => row.completion).length, 1);
    assert.deepEqual(events, ['close']);
  });
}

test('bounds the missing completion join by the existing delivery timeout', async () => {
  let signal;
  const { host, events } = sdkHarness(({ request }) => { signal = request.signal; return { data: { info: stop, parts: [] } }; });
  const result = await runCase('unicode-preference', { host, timeout_ms: 2, budget: { mode: 'offline', approved: false } });
  assert.equal(result.reason, 'host_boundary_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(result.completion_evidence[0].failure_origin, 'boundary.completion_join');
  assert.deepEqual(events, ['close']);
});

test('retains SDK cancellation without joining or settling', async () => {
  const { host, events } = sdkHarness(() => { throw new DOMException('SECRET', 'AbortError'); });
  const result = await runCase('unicode-preference', { host, budget: { mode: 'offline', approved: false } });
  assert.equal(result.reason, 'host_boundary_failed');
  assert.equal(result.completion_evidence[0].failure_origin, 'sdk.deliver');
  assert.deepEqual(events, ['close']);
});

test('retains source framing failure origin without accepting a source or stop', async () => {
  const host = fakeHost({ mutateSource(source) { source.part.state.metadata.display.text = 'invented'; } });
  const result = await runCase('read-route', { host, budget: { mode: 'offline', approved: false } });
  assert.equal(result.reason, 'native_source_bytes_or_framing');
  assert.equal(result.completion_evidence[0].failure_origin, 'boundary.tool');
  assert.deepEqual(result.custody.map((row) => row.logical), ['u1']);
});

test('retains the first source failure and origin when a later completion also fails', async () => {
  const host = fakeHost();
  const deliver = host.deliver;
  host.deliver = (packet, boundary) => deliver(packet, { ...boundary, async tool(value) {
    value.part.state.status = 'error';
    assert.throws(() => boundary.tool(value), /native_source_status/);
    assert.throws(() => boundary.complete({}), /native_completion_missing/);
  }, complete(info) { assert.throws(() => boundary.complete(info), /source_stage_missing/); } });
  const result = await runCase('read-route', { host, budget: { mode: 'offline', approved: false } });
  assert.equal(result.reason, 'native_source_status');
  assert.equal(result.completion_evidence[0].failure_origin, 'boundary.tool');
});

test('keeps the SDK secret early screen free of completion joins and reviews', async () => {
  const { host, events } = sdkHarness(() => ({ error: { name: 'screened_whole_unit' } }));
  const result = await runCase('synthetic-secret', { host, budget: { mode: 'offline', approved: false } });
  assert.equal(result.status, 'wired');
  assert.equal(result.turns[0].status, 'screened_whole_unit');
  assert.equal(result.budget_used.provider_requests ?? 0, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(result.custody, []);
  assert.equal(result.budget_used.host_opens ?? 0, 0);
});

test('recall packet binds query to original seeded body and placement', async () => {
  const { original } = require('../capture-quality-population/inputs.cjs').resolveCase('recalled-unused');
  const host = fakeHost(); let packet;
  host.deliver = async (value) => { packet = value; throw new Error('stop_at_packet'); };
  const result = await runCase('recalled-unused', { host, budget: { mode: 'offline' } });
  assert.equal(packet.memories[0].recall_query, original.record.body);
  assert.equal(packet.memories[0].placement, result.seeds[0].placement);
});

test('delivers an original turn and binds source aliases to observed native IDs', async () => {
  const calls = [];
  const host = {
    mode: 'offline',
    async open() { return { sessionID: 'actual-session', origin: 'repository:actual' }; },
    async deliver(packet, boundary) {
      calls.push(packet);
      await boundary.user({ message: { id: 'actual-user', sessionID: 'actual-session', role: 'user' },
        parts: [{ id: 'actual-user-part', sessionID: 'actual-session', messageID: 'actual-user', type: 'text', text: packet.user }] });
      const operation = packet.operations[0];
      const translation = await boundary.prepare(operation.token);
      const output = translation.text;
      const filePath = translation.input.filePath;
      await boundary.tool({ userID: 'actual-user', message: { id: 'actual-assistant', sessionID: 'actual-session', role: 'assistant', parentID: 'actual-user' },
        part: { id: 'actual-part', messageID: 'actual-assistant', sessionID: 'actual-session', type: 'tool', tool: 'read', callID: 'actual-call',
          state: { status: 'completed', input: { filePath }, time: { start: 1, end: 2 }, output: `<path>${filePath}</path>\n<type>file</type>\n<content>\n1: ${output}\n\n(End of file - total 1 lines)\n</content>`,
            metadata: { truncated: false, display: { type: 'file', path: filePath, text: output, truncated: false, lineStart: 1, lineEnd: 1, totalLines: 1 } } } } });
      await boundary.complete({ id: 'actual-assistant', sessionID: 'actual-session', parentID: 'actual-user', role: 'assistant', finish: 'stop', time: { completed: 3 } });
    },
    async settle() { return { status: 'no_candidate' }; },
    async close() { return { exited: true, children: 0, removed: true }; },
  };
  const result = await runCase('read-route', { host, budget: { mode: 'offline', approved: false } });
  assert.equal(result.status, 'wired');
  assert.equal(calls[0].user, 'Find the alpha entry.');
  assert.deepEqual(result.custody.find((row) => row.logical === 's1').actual,
    { session: 'actual-session', user: 'actual-user', message: 'actual-assistant', part: 'actual-part', call: 'actual-call', tool: 'read' });
});

test('blocks before any supplied host action when a separate budget is absent', async () => {
  let calls = 0;
  const host = { mode: 'native', async open() { calls++; } };
  const result = await runCase('read-route', { host });
  assert.equal(result.reason, 'separate_approved_budget_required');
  assert.equal(calls, 0);
});
