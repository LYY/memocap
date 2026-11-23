const assert = require('node:assert/strict');
const test = require('node:test');
const { accessHost } = require('./plugin-access-fixture.cjs');
const { memory, receipt } = require('./plugin-fixture.cjs');

async function fixture(readbackTags, beforeSpawn) {
  const current = await accessHost({ respond(argv, options, result) {
    if (argv[0] === 'remember') {
      beforeSpawn?.(current);
      options.beforeSpawn();
      return { receipt: receipt('remember', { status: 'inserted', returned_ids: [9], searched_placements: [current.turn.target.placement] }) };
    }
    if (argv[0] === 'read') {
      const entry = memory(9, 'Grounded whole unit.');
      entry.memory.tags = readbackTags ?? current.turn.candidate.tags.join(',');
      return { receipt: receipt('read', { returned_ids: [9], results: [entry] }) };
    }
    return result;
  } });
  const { createLifecycle } = await import('../plugin/capture/lifecycle.js');
  const { createBinding } = await import('../plugin/capture/binding.js');
  const { createObserved } = await import('../plugin/capture/observed.js');
  const { createTools } = await import('../plugin/tools.js');
  const lifecycle = createLifecycle(() => {});
  const observed = createObserved();
  current.observed = observed;
  lifecycle.observe({ sessionID: 'A', agent: 'build' }, { message: { role: 'user', id: 'u' }, parts: [{ type: 'text', text: 'Real input.' }] });
  observed.observe({ sessionID: 'A' }, { message: { role: 'user', id: 'u' }, parts: [{ id: 'input', type: 'text', text: 'Real input.' }] });
  const turn = lifecycle.event({ type: 'session.status', properties: { sessionID: 'A', status: { type: 'idle' } } });
  turn.targets = await current.runtime.selected(await current.runtime.context('A'));
  turn.target = { repository_id: turn.targets[0].repository_id, placement: turn.targets[0].repository_id };
  turn.parentState = await current.runtime.context('A');
  turn.runtimeGeneration = turn.parentState.generation;
  turn.observationHash = require('node:crypto').createHash('sha256').update(JSON.stringify(observed.snapshot('A', 'u'))).digest('hex');
  turn.candidate = { body: 'Grounded whole unit.', tags: Object.freeze(['memocap-capture-host-fingerprint']) };
  lifecycle.worker('worker', turn, 'commit');
  current.input.client.session.messages = async ({ path }) => { assert.equal(path.id, 'worker'); return { data: [
    { info: { id: 'explicit' }, parts: [{ type: 'tool', tool: 'memocap_remember', callID: 'call1',
      state: { status: 'running', input: { content: 'Grounded whole unit.' } } }] },
  ] }; };
  const binding = createBinding({ client: current.input.client, runtime: current.runtime, operations: current.operations, lifecycle, observed });
  const tools = createTools(current.operations, binding);
  const context = { ...current.context, sessionID: 'worker' };
  binding.before({ sessionID: 'worker', tool: 'memocap_remember', callID: 'call1' });
  current.turn = turn;
  const execute = async (args = { content: turn.candidate.body }) => {
    try { return JSON.parse((await tools.memocap_remember.execute(args, context)).output); }
    finally { observed.dispose(); }
  };
  return { ...current, turn, lifecycle, binding, context, execute };
}

for (const flags of [{ synthetic: true }, { ignored: true }, { metadata: { memocap: true } }]) {
  test(`retraction after async guard blocks native spawn for ${Object.keys(flags)[0]}`, async () => {
    const current = await fixture(undefined, ({ observed }) => {
      observed.event({ type: 'message.part.updated', properties: { part: {
        sessionID: 'A', messageID: 'u', id: 'input', type: 'text', text: 'Real input.', ...flags,
      } } });
    });
    const result = await current.execute();
    assert.equal(result.status, 'blocked');
    assert.equal(result.error.code, 'source_changed');
    assert.equal(current.turn.write_attempts, 0);
    assert.equal(current.calls.some(({ argv }) => argv[0] === 'read'), false);
  });
}

test('unit seam rechecks parent permission after native ask even if ask resolves from a host approval cache', async () => {
  const current = await fixture();
  current.context.ask = async () => { current.session.permission = [{ permission: 'memocap_remember', pattern: current.turn.target.repository_id, action: 'deny' }]; };
  const result = await current.execute();
  assert.equal(result.status, 'denied');
  assert.equal(current.turn.outcome.reason, 'permission_deny');
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'remember'), false);
});

test('unit seam rechecks effective agent permission before asking', async () => {
  const current = await fixture();
  current.rules.push({ permission: 'memocap_remember', pattern: '*', action: 'deny' });
  const result = await current.execute();
  assert.equal(result.status, 'denied');
  assert.equal(current.asks.length, 0);
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'remember'), false);
});

test('capture denies an optional trailing space-star rule before native ask', async () => {
  const current = await fixture();
  current.rules.push({ permission: 'memocap_remember *', pattern: '*', action: 'deny' });

  const result = await current.execute();

  assert.equal(result.status, 'denied');
  assert.equal(current.turn.outcome.reason, 'permission_deny');
  assert.equal(current.asks.length, 0);
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'remember'), false);
});

test('capture denies a space-star rule added while cached native ask resolves', async () => {
  const current = await fixture();
  current.context.ask = async (request) => {
    current.asks.push(request);
    current.session.permission.push({ permission: 'memocap_remember *', pattern: '*', action: 'deny' });
  };

  const result = await current.execute();

  assert.equal(result.status, 'denied');
  assert.equal(current.turn.outcome.reason, 'permission_deny');
  assert.equal(current.asks.length, 1);
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'remember'), false);
});

for (const action of ['allow', 'deny']) {
  test(`capture honors the last matching wildcard session override: ${action}`, async () => {
    const current = await fixture();
    current.rules.push({ permission: 'memocap_*', pattern: '*', action: action === 'allow' ? 'deny' : 'allow' });
    current.session.permission.push({ permission: 'memocap_remembe? *', pattern: 'repository:*', action });

    const result = await current.execute();

    assert.equal(current.calls.some(({ argv }) => argv[0] === 'remember'), action === 'allow');
    assert.equal(result.status, action === 'allow' ? 'inserted' : 'denied');
  });
}

for (const [name, repository, pattern] of [
  ['case', 'repository:ABC', 'REPOSITORY:abc'],
  ['slashes', 'C:\\repositories\\project', 'C:/repositories/*'],
]) {
  test(`capture snapshot uses Windows wildcard ${name} semantics`, async (context) => {
    const { permissionSnapshot } = await import('../plugin/capture/permission.js');
    const current = await fixture();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    context.after(() => Object.defineProperty(process, 'platform', platform));
    Object.defineProperty(process, 'platform', { value: 'win32' });
    current.turn.target.repository_id = repository;
    current.rules.push({ permission: 'memocap_remember', pattern, action: 'deny' });

    await assert.rejects(permissionSnapshot(current.input.client, current.turn), { code: 'permission_deny' });
  });
}

test('unit seam consumes mismatched attempts and blocks a later corrected request', async () => {
  const current = await fixture();
  const first = await current.execute({ content: 'Model invented content.' });
  const second = await current.execute();
  assert.equal(first.error.code, 'candidate_mismatch');
  assert.equal(second.error.code, 'attempt_consumed');
  assert.equal(current.asks.length, 0);
});

test('unit seam rejects a callback whose host message does not carry the bound call ID', async () => {
  const current = await fixture();
  current.context.messageID = 'different-message';
  const result = await current.execute();
  assert.equal(result.error.code, 'call_mismatch');
  assert.equal(current.asks.length, 0);
});

test('unit seam counts generation hooks and prevents dispatch four before generation', async () => {
  const current = await fixture();
  const output = {};
  current.lifecycle.worker('extract', current.turn, 'extract');
  current.binding.params({ sessionID: 'extract' }, output);
  current.binding.params({ sessionID: 'extract' }, output);
  current.binding.params({ sessionID: 'worker' }, output);
  assert.throws(() => current.binding.params({ sessionID: 'worker' }, output), { code: 'model_budget' });
  assert.equal(current.turn.model_calls, 3);
});

test('unit seam refuses unbound tools before execution', async () => {
  const current = await fixture();
  assert.throws(() => current.binding.before({ sessionID: 'worker', tool: 'bash', callID: 'call2' }), { code: 'unbound_tool' });
  assert.equal(current.turn.reason, 'unbound_tool');
  assert.equal(current.turn.write_attempts, 0);
});

test('unit seam binds the exact candidate and prevents another native write after a successful readback', async () => {
  const current = await fixture();
  const first = await current.execute();
  const second = await current.execute();
  assert.equal(first.readback.status, 'ok');
  assert.equal(current.turn.outcome.status, 'saved');
  assert.equal(second.error.code, 'attempt_consumed');
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'remember').length, 1);
});

test('two before hooks preceding execution fail closed and consume the competing attempt', async () => {
  const current = await fixture();
  current.binding.before({ sessionID: 'worker', tool: 'memocap_remember', callID: 'call2' });

  const first = await current.execute();
  const second = await current.execute({ content: 'second unbound write' });

  assert.equal(first.error.code, 'candidate_mismatch');
  assert.deepEqual(current.turn.outcome, { status: 'skipped', reason: 'candidate_mismatch' });
  assert.equal(second.error.code, 'attempt_consumed');
  assert.equal(current.turn.write_attempts, 0);
  assert.equal(current.calls.filter(({ argv }) => ['remember', 'read'].includes(argv[0])).length, 0);
});

test('a second before hook after exact commit readback preserves the saved receipt', async () => {
  const current = await fixture();
  const first = await current.execute();
  const outcome = current.turn.outcome;

  current.binding.before({ sessionID: 'worker', tool: 'memocap_remember', callID: 'call2' });
  const second = await current.execute({ content: 'second unbound write' });

  assert.equal(first.readback.status, 'ok');
  assert.equal(current.turn.outcome, outcome);
  assert.equal(outcome.status, 'saved');
  assert.equal(outcome.receipt, current.turn.receipt);
  assert.deepEqual(outcome.receipt, first);
  assert.equal(second.error.code, 'attempt_consumed');
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'remember').length, 1);
});

test('a second before hook during the first message await preserves the validated first commit', async () => {
  const current = await fixture();
  const messages = current.input.client.session.messages;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  current.input.client.session.messages = async (request) => { entered.resolve(); await release.promise; return messages(request); };

  const pending = current.execute();
  await entered.promise;
  current.binding.before({ sessionID: 'worker', tool: 'memocap_remember', callID: 'call2' });
  release.resolve();
  const first = await pending;
  const second = await current.execute({ content: 'second unbound write' });

  assert.equal(first.readback.status, 'ok');
  assert.equal(current.turn.outcome.status, 'saved');
  assert.deepEqual(current.turn.outcome.receipt, first);
  assert.equal(second.error.code, 'attempt_consumed');
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'remember').length, 1);
});

test('finished worker tombstones block late generation and tools without reopening a capture', async () => {
  const current = await fixture();
  current.lifecycle.finish(current.turn);
  assert.throws(() => current.binding.params({ sessionID: 'worker' }, {}), { code: 'worker_closed' });
  assert.throws(() => current.binding.before({ sessionID: 'worker', tool: 'memocap_remember', callID: 'late' }), { code: 'worker_closed' });
  assert.equal((await current.execute()).error.code, 'worker_closed');
  assert.equal(current.turn.model_calls, 0);
  assert.equal(current.asks.length, 0);
});

test('a native readback with a changed fingerprint never reports saved or retries', async () => {
  const current = await fixture('memocap-capture-wrong-fingerprint');
  const result = await current.execute();
  assert.equal(result.readback.status, 'failed');
  assert.equal(current.turn.outcome.status, 'unknown');
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'remember').length, 1);
  assert.equal((await current.execute()).error.code, 'attempt_consumed');
});

for (const fields of [{ tags: ['model-tag'] }, { topic: 'model-topic' }, { force: true }, { origin: 'model' }]) {
  test(`model cannot select capture metadata ${Object.keys(fields)[0]}`, async () => {
    const current = await fixture();
    assert.equal((await current.execute({ content: current.turn.candidate.body, ...fields })).error.code, 'candidate_mismatch');
    assert.equal(current.asks.length, 0);
    assert.equal(current.calls.some(({ argv }) => argv[0] === 'remember'), false);
  });
}
