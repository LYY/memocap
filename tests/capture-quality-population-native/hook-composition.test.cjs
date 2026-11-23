const assert = require('node:assert/strict');
const test = require('node:test');
const { productionProbe } = require('./production-probe.cjs');

for (const entrypoint of ['plugin', 'native']) {
  for (const tool of ['memocap_maintain', 'memocap_organize', 'memocap_scope', 'memocap_recall', 'memocap_read', 'memocap_remember']) {
    test(`${entrypoint} restores the complete ${tool} receipt after host truncation`, async (context) => {
      const probe = await productionProbe();
      const factory = entrypoint === 'native' ? probe.factory : (await probe.load('../../plugin/index.js')).namespace.default.server;
      const hooks = await factory({ directory: '/synthetic/project', client: { session: {} } }, { invoke: async () => assert.fail('native_forbidden') });
      context.after(() => hooks.dispose());
      const output = { output: 'truncated', metadata: { memocap_complete_output: '{"status":"ok","ids":[7,9]}', truncated: true, outputPath: '/host/spill', retained: 42 } };

      await hooks['tool.execute.after']({ tool }, output);

      assert.deepEqual(output, { output: '{"status":"ok","ids":[7,9]}', metadata: { truncated: false, retained: 42 } });
      assert.deepEqual(probe.defaults, []);
    });
  }
  for (const [tool, metadata] of [['read', { memocap_complete_output: 'private', truncated: true }],
    ['memocap_read', { memocap_complete_output: 4, truncated: true }], ['memocap_read', undefined]]) {
    test(`${entrypoint} leaves unrelated or incomplete output untouched: ${tool}/${typeof metadata?.memocap_complete_output}`, async (context) => {
      const probe = await productionProbe();
      const factory = entrypoint === 'native' ? probe.factory : (await probe.load('../../plugin/index.js')).namespace.default.server;
      const hooks = await factory({ directory: '/synthetic/project', client: { session: {} } }, { invoke: async () => assert.fail('native_forbidden') });
      context.after(() => hooks.dispose());
      const output = { output: 'host output', metadata: structuredClone(metadata) };
      const expected = structuredClone(output);

      await hooks['tool.execute.after']({ tool }, output);

      assert.deepEqual(output, expected);
    });
  }
}

test('native factory actual organize apply tool refuses before permission or injected dispatch', async (context) => {
  const probe = await productionProbe();
  let invocations = 0;
  let asks = 0;
  const hooks = await probe.factory({ directory: '/synthetic/project', client: { session: {} } }, {
    invoke: async () => { invocations++; assert.fail('native_forbidden'); } });
  context.after(() => hooks.dispose());

  await assert.rejects(hooks.tool.memocap_organize.execute({ operation: 'apply', request: '{}', confirmed: true }, {
    sessionID: 'parent', messageID: 'message', abort: new AbortController().signal, metadata() {}, ask: async () => { asks++; },
  }), { code: 'quality_organization_apply_forbidden' });

  assert.equal(invocations, 0);
  assert.equal(asks, 0);
  assert.deepEqual(probe.defaults, []);
});

async function composition() {
  const probe = await productionProbe();
  const { composeHooks } = (await probe.load('../../plugin/hooks.js')).namespace;
  const calls = [];
  const components = {};
  for (const owner of ['runtime', 'commands', 'maintenance', 'capture']) {
    components[owner] = Object.fromEntries(['config', 'execute', 'params', 'before', 'observe', 'messages', 'system', 'compact', 'transform', 'capture', 'event', 'dispose']
      .map((method) => [method, (...args) => { calls.push({ name: `${owner}.${method}`, args }); return `${owner}.${method}`; }]));
    components[owner].owns = (id) => id === `${owner}-worker`;
  }
  const hooks = composeHooks({ ...components, operations: {}, policy: { rules: 'synthetic-rule' } });
  return { hooks, calls, components };
}

for (const [hook, expected, outputOnly] of [
  ['config', ['runtime.config', 'maintenance.config', 'commands.config']],
  ['chat.params', ['maintenance.params', 'capture.params']],
  ['tool.execute.before', ['maintenance.before', 'capture.before']],
  ['command.execute.before', ['commands.execute']],
  ['chat.message', ['maintenance.observe', 'capture.observe', 'runtime.capture']],
  ['experimental.chat.messages.transform', ['maintenance.messages', 'capture.messages', 'runtime.transform'], true],
  ['experimental.chat.system.transform', ['maintenance.system', 'capture.system']],
]) test(`${hook} forwards original arguments in production order`, async () => {
  const current = await composition();
  const input = { sessionID: 'parent' };
  const output = { messages: [{ info: { sessionID: 'parent' } }] };

  await current.hooks[hook](input, output);

  assert.deepEqual(current.calls.map(({ name }) => name), expected);
  for (const call of current.calls) {
    const args = hook === 'config' ? [input] : outputOnly && call.name !== 'runtime.transform' ? [output] : [input, output];
    assert.deepEqual(call.args, args);
  }
});

for (const owner of ['capture', 'maintenance']) {
  test(`${owner} worker chat never reenters parent observation`, async () => {
    const current = await composition();

    await current.hooks['chat.message']({ sessionID: `${owner}-worker` }, {});

    assert.deepEqual(current.calls, []);
  });
  test(`${owner} worker messages reach workflow transforms but never recall`, async () => {
    const current = await composition();

    await current.hooks['experimental.chat.messages.transform']({}, { messages: [
      { info: { sessionID: 'parent' } }, { info: { sessionID: `${owner}-worker` } },
    ] });

    assert.deepEqual(current.calls.map(({ name }) => name), ['maintenance.messages', 'capture.messages']);
  });
}

for (const [properties, expected] of [
  [{ sessionID: 'parent' }, ['maintenance.event', 'capture.event', 'runtime.event']],
  [{ sessionID: 'maintenance-worker', info: { sessionID: 'parent' } }, ['maintenance.event']],
  [{ info: { sessionID: 'capture-worker' } }, ['maintenance.event', 'capture.event']],
  [{ part: { sessionID: 'maintenance-worker' } }, ['maintenance.event']],
  [{ info: { id: 'capture-worker' } }, ['maintenance.event', 'capture.event']],
  [{}, ['maintenance.event', 'capture.event', 'runtime.event']],
]) test(`event routes session ownership through ${JSON.stringify(properties)}`, async () => {
  const current = await composition();
  const event = { event: { type: 'synthetic', properties } };

  const forwarded = current.hooks.event(event);

  assert.deepEqual(current.calls.map(({ name }) => name), expected);
  for (const call of current.calls) assert.equal(call.args[0], event);
  assert.equal(forwarded, expected.includes('runtime.event') ? 'runtime.event' : undefined);
});

test('event ownership is evaluated after maintenance consumes the event', async () => {
  const current = await composition();
  let owned = false;
  current.components.maintenance.event = () => { owned = true; };
  current.components.maintenance.owns = () => owned;

  current.hooks.event({ event: { properties: { sessionID: 'new-worker' } } });

  assert.deepEqual(current.calls, []);
});

for (const hook of ['chat.params', 'tool.execute.before']) test(`${hook} stops before capture when maintenance refuses`, async () => {
  const current = await composition();
  const refusal = new Error('synthetic_refusal');
  current.components.maintenance[hook === 'chat.params' ? 'params' : 'before'] = () => { throw refusal; };

  assert.throws(() => current.hooks[hook]({}, {}), refusal);

  assert.deepEqual(current.calls, []);
});

test('compaction waits for recall before appending the rule to the same context', async () => {
  const current = await composition();
  const gate = Promise.withResolvers();
  const input = { sessionID: 'parent' };
  const output = { context: ['existing'] };
  current.components.runtime.compact = (forwarded) => { assert.equal(forwarded, input); return gate.promise; };

  const pending = current.hooks['experimental.session.compacting'](input, output);
  assert.deepEqual(output.context, ['existing']);
  gate.resolve();
  await pending;

  assert.deepEqual(output.context, ['existing', 'synthetic-rule']);
});

test('dispose awaits maintenance then capture before disposing recall', async () => {
  const current = await composition();
  const maintenance = Promise.withResolvers();
  const capture = Promise.withResolvers();
  const captureEntered = Promise.withResolvers();
  current.components.maintenance.dispose = () => { current.calls.push({ name: 'maintenance.dispose' }); return maintenance.promise; };
  current.components.capture.dispose = () => { current.calls.push({ name: 'capture.dispose' }); captureEntered.resolve(); return capture.promise; };

  const pending = current.hooks.dispose();
  assert.deepEqual(current.calls.map(({ name }) => name), ['maintenance.dispose']);
  maintenance.resolve();
  await captureEntered.promise;
  assert.deepEqual(current.calls.map(({ name }) => name), ['maintenance.dispose', 'capture.dispose']);
  capture.resolve();
  await pending;

  assert.deepEqual(current.calls.map(({ name }) => name), ['maintenance.dispose', 'capture.dispose', 'runtime.dispose']);
});
