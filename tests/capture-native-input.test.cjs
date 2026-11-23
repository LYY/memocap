const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture() {
  const { createLifecycle } = await import('../plugin/capture/lifecycle.js');
  const { createBinding } = await import('../plugin/capture/binding.js');
  const lifecycle = createLifecycle(() => {});
  lifecycle.observe({ sessionID: 'parent' }, { message: { role: 'user', id: 'user' }, parts: [{ type: 'text', text: 'Safe input.' }] });
  const turn = lifecycle.parents.get('parent');
  lifecycle.worker('child', turn, 'extract');
  const binding = createBinding({ lifecycle });
  const messages = (...texts) => ({ messages: texts.map((text) => ({ info: { sessionID: 'child' }, parts: [{ type: 'text', text }] })) });
  return { lifecycle, turn, binding, messages };
}

function assertStopped({ binding, lifecycle, turn }, reason) {
  assert.equal(turn.reason, reason);
  assert.equal(turn.controller.signal.aborted, true);
  const worker = lifecycle.workers.get('child');
  assert.equal(Object.hasOwn(worker, 'messageInput'), false);
  assert.equal(Object.hasOwn(worker, 'systemInput'), false);
  assert.equal(turn.model_calls, 0);
  assert.throws(() => binding.params({ sessionID: 'child' }, {}), { code: reason });
  assert.equal(turn.model_calls, 0);
}

for (const surface of ['system', 'messages', 'parts', 'accumulated', 'system_messages', 'metadata', 'unicode']) {
  test(`capture rejects native ${surface} secrets or malformed input before generation`, async () => {
    const current = await fixture();
    const { binding, messages } = current;
    const check = () => {
      if (surface === 'system') binding.system({ sessionID: 'child' }, { system: ['password=fixture-only'] });
      if (surface === 'messages') binding.messages(messages('password=fixture-only'));
      if (surface === 'parts') {
        const output = messages('pass');
        output.messages[0].parts.push({ type: 'text', text: 'word=fixture-only' });
        binding.messages(output);
      }
      if (surface === 'accumulated') binding.messages(messages('pass', 'word=fixture-only'));
      if (surface === 'system_messages') {
        binding.messages(messages('word=fixture-only'));
        binding.system({ sessionID: 'child' }, { system: ['pass'] });
      }
      if (surface === 'metadata') {
        const output = messages('Safe input.');
        output.messages[0].parts.push({ type: 'tool', state: { input: { password: 'fixture-only' } } });
        binding.messages(output);
      }
      if (surface === 'unicode') binding.messages(messages('\ud800'));
    };
    assert.throws(check, { code: 'sensitive_input' });
    assertStopped(current, 'sensitive_input');
  });
}

for (const order of [['messages', 'system'], ['system', 'messages']]) {
  test(`capture rejects secrets split across parts, messages and system in ${order.join(' then ')} order`, async () => {
    const current = await fixture();
    const { binding, messages, lifecycle, turn } = current;
    const output = messages('wo', '=fixture-only');
    output.messages[0].parts.push({ type: 'text', text: 'rd' });
    const hooks = {
      messages: () => binding.messages(output),
      system: () => binding.system({ sessionID: 'child' }, { system: ['pass'] }),
    };
    hooks[order[0]]();
    assert.ok(lifecycle.workers.get('child')[`${order[0] === 'messages' ? 'message' : 'system'}Input`]);
    assert.equal(turn.model_calls, 0);

    assert.throws(hooks[order[1]], { code: 'sensitive_input' });

    assertStopped(current, 'sensitive_input');
  });

  for (const bytes of [49152, 49153]) {
    test(`explicit UTF8 byte-boundary padding: ${bytes} combined bytes in ${order.join(' then ')} order`, async (context) => {
      const current = await fixture();
      const { binding, lifecycle, turn, messages } = current;
      const output = messages('A\u4e2d\u{1f680} '.repeat(2048));
      const system = ['S\u4e2d\u{1f680} '.repeat(1024)];
      const messageBytes = Buffer.byteLength(JSON.stringify(output.messages));
      const paddingBytes = bytes - messageBytes - Buffer.byteLength(JSON.stringify(system));
      system[0] += 's '.repeat(Math.floor(paddingBytes / 2)) + 's'.repeat(paddingBytes % 2);
      const systemBytes = Buffer.byteLength(JSON.stringify(system));
      assert.equal(messageBytes + systemBytes, bytes);
      assert.ok(JSON.stringify(output.messages).length + JSON.stringify(system).length < 49152);
      assert.ok(messageBytes < 49152 && systemBytes < 49152);
      const hooks = {
        messages: () => binding.messages(output),
        system: () => binding.system({ sessionID: 'child' }, { system }),
      };
      hooks[order[0]]();
      assert.equal(turn.model_calls, 0);
      const worker = lifecycle.workers.get('child');
      assert.ok(worker[`${order[0] === 'messages' ? 'message' : 'system'}Input`]);

      if (bytes === 49153) {
        assert.throws(hooks[order[1]], { code: 'input_budget' });
        assertStopped(current, 'input_budget');
      } else {
        assert.doesNotThrow(hooks[order[1]]);
        assert.equal(turn.model_calls, 0);
        assert.equal(turn.controller.signal.aborted, false);
        assert.ok(worker.messageInput.length > 0 && worker.systemInput.length > 0);
        assert.equal(worker.messageBytes, messageBytes);
        assert.equal(worker.systemBytes, systemBytes);
        assert.doesNotThrow(() => binding.params({ sessionID: 'child' }, {}));
        assert.equal(turn.model_calls, 1);
        lifecycle.finish(turn);
        assert.equal(Object.hasOwn(worker, 'messageInput'), false);
        assert.equal(Object.hasOwn(worker, 'systemInput'), false);
        assert.throws(() => binding.params({ sessionID: 'child' }, {}), { code: 'worker_closed' });
        assert.equal(turn.model_calls, 1);
      }
      context.diagnostic(JSON.stringify({ order, messageBytes, systemBytes, bytes, model_calls: turn.model_calls }));
    });
  }

  test(`capture deletes both retained fragments on ${order[1]} revalidation failure`, async () => {
    const current = await fixture();
    const { binding, lifecycle, messages } = current;
    const hooks = {
      messages: (text) => binding.messages(messages(text)),
      system: (text) => binding.system({ sessionID: 'child' }, { system: [text] }),
    };
    for (const hook of order) hooks[hook]('Safe input.');
    const worker = lifecycle.workers.get('child');
    assert.ok(worker.messageInput.length > 0 && worker.systemInput.length > 0);

    assert.throws(() => hooks[order[1]]('password=fixture-only'), { code: 'sensitive_input' });

    assertStopped(current, 'sensitive_input');
  });
}

test('capture ignores unrelated sessions and refuses mixed native worker identity', async () => {
  const current = await fixture();
  const { binding, messages } = current;
  assert.doesNotThrow(() => binding.system({ sessionID: 'parent' }, { system: ['password=unrelated'] }));
  const output = messages('Safe input.');
  output.messages.push({ info: { sessionID: 'parent' }, parts: [{ type: 'text', text: 'Safe input.' }] });
  assert.throws(() => binding.messages(output), { code: 'task_changed' });
  assertStopped(current, 'task_changed');
});

test('safe native input preserves generation budgets and releases fragments at finish', async () => {
  const { binding, lifecycle, turn, messages } = await fixture();
  binding.messages(messages('Safe input.'));
  binding.system({ sessionID: 'child' }, { system: ['Safe system.'] });
  binding.params({ sessionID: 'child' }, {});
  binding.params({ sessionID: 'child' }, {});
  assert.throws(() => binding.params({ sessionID: 'child' }, {}), { code: 'model_budget' });
  assert.equal(turn.model_calls, 2);
  lifecycle.finish(turn);
  assert.equal(lifecycle.workers.get('child').messageInput, undefined);
  assert.equal(lifecycle.workers.get('child').systemInput, undefined);
});
