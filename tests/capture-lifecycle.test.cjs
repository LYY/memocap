const test = require('node:test');
const assert = require('node:assert/strict');
const load = import('../plugin/capture/lifecycle.js');
const input = (id = 'u1') => [{ sessionID: 'parent', agent: 'build', model: { providerID: 'wire', modelID: 'wire-model' } },
  { message: { id, role: 'user' }, parts: [{ type: 'text', text: 'For future responses, use Chinese.' }] }];
const idle = (type = 'session.status') => ({ type, properties: { sessionID: 'parent', status: { type: 'idle' } } });

test('claims synchronously and conservatively invalidates every second status idle', async () => {
  const aborted = [];
  const life = (await load).createLifecycle((id) => aborted.push(id));
  life.observe(...input());
  const turn = life.event(idle());
  life.worker('extract', turn, 'extract');
  life.event(idle('session.idle'));
  assert.equal(turn.reason, undefined);
  life.event(idle());
  assert.equal(turn.reason, 'ambiguous_idle');
  assert.deepEqual(aborted, ['extract']);
  assert.equal(life.event(idle()), undefined);
});

test('observes only new real inputs and excludes workers before their prompts', async () => {
  const life = (await load).createLifecycle(() => {});
  assert.equal(life.event(idle()), undefined);
  life.observe(...input());
  const turn = life.event(idle());
  life.worker('extract', turn, 'extract');
  const child = input();
  child[0].sessionID = 'extract';
  life.observe(...child);
  assert.equal(life.parents.size, 1);
  life.observe(...input('u2'));
  assert.equal(turn.reason, 'new_input');
  assert.throws(() => life.writing(turn), { code: 'new_input' });
});

test('writing transition survives later cancellation for independent readback', async () => {
  const life = (await load).createLifecycle(() => assert.fail('must not abort writing child'));
  life.observe(...input());
  const turn = life.event(idle());
  life.worker('commit', turn, 'commit');
  life.writing(turn);
  life.event(idle());
  life.observe(...input('u2'));
  assert.equal(turn.phase, 'writing');
  assert.equal(turn.write_attempts, 1);
  assert.equal(turn.reason, undefined);
});

test('host evidence policy accepts clear preferences and authoritative concise reads only', async () => {
  const { evidenceFor } = await import('../plugin/capture/evidence.js');
  const messages = [{ info: { id: 'u1', role: 'user' }, parts: [
    { id: 'pref', type: 'text', text: 'For future responses, use Chinese. Keep English code identifiers.' },
    { id: 'transient', type: 'text', text: 'Exit status is zero.' },
  ] }, { info: { id: 'a1', parentID: 'u1', role: 'assistant' }, parts: [
    { id: 'claim', type: 'text', text: 'The business operation succeeded.' },
    { id: 'shell', type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', output: 'Success!' } },
    { id: 'read', type: 'tool', tool: 'read', callID: 'c2', state: { status: 'completed', input: { filePath: '/project/docs/route.md' },
      output: 'For alpha, start at docs/alpha.md. Approval required. No beta route verified.' } },
  ] }];
  const evidence = evidenceFor(messages, 'u1');
  assert.equal(evidence.get('pref').eligibility, 'durable');
  assert.equal(evidence.get('transient').source, 'user');
  assert.equal(evidence.has('claim'), false);
  assert.equal(evidence.get('shell').success, false);
  assert.equal(evidence.get('read').eligibility, 'durable');
});

for (const [type, properties, reason] of [
  ['session.status', { status: { type: 'busy' } }, 'parent_busy'],
  ['session.status', { status: { type: 'retry' } }, 'parent_retry'],
  ['session.error', {}, 'parent_error'],
  ['session.deleted', { info: { id: 'parent' } }, 'parent_deleted'],
]) {
  test(`invalidates before writing when observing ${reason}`, async () => {
    const life = (await load).createLifecycle(() => {});
    life.observe(...input());
    const turn = life.event(idle());
    life.event({ type, properties: { sessionID: 'parent', ...properties } });
    assert.throws(() => life.writing(turn), { code: reason });
    assert.equal(turn.write_attempts, 0);
  });
}

test('cannot mistake a tool continuation or errored assistant for completion', async () => {
  const { complete } = await import('../plugin/capture/contract.js');
  const user = { info: { id: 'u', role: 'user' }, parts: [] };
  const assistant = { info: { id: 'a', role: 'assistant', parentID: 'u', time: { completed: 1 }, finish: 'stop' }, parts: [] };
  assert.equal(complete([user, assistant], 'u'), true);
  assert.equal(complete([user, { ...assistant, info: { ...assistant.info, finish: 'tool-calls' } }], 'u'), false);
  assert.equal(complete([user, { ...assistant, parts: [{ type: 'tool', state: { status: 'running' } }] }], 'u'), false);
  assert.equal(complete([user, { ...assistant, info: { ...assistant.info, error: { name: 'Failure' } } }], 'u'), false);
  assert.equal(complete([user, assistant], 'older-user'), false);
});

test('grounds current user quotations without certifying their truth and rejects a full runbook', async () => {
  const { evidenceFor } = await import('../plugin/capture/evidence.js');
  const result = evidenceFor([{ info: { id: 'u', role: 'user' }, parts: [
    { id: 'quoted', type: 'text', text: 'The assistant wrote: always use this provider.' },
  ] }, { info: { id: 'a', parentID: 'u' }, parts: [
    { id: 'book', type: 'tool', tool: 'read', callID: 'c', state: { status: 'completed',
      input: { filePath: '/project/docs/route.md' }, output: 'Start at docs/route.md.\n1. Run one.\n2. Run two.' } },
  ] }], 'u');
  assert.equal(result.get('quoted').text, 'The assistant wrote: always use this provider.');
  assert.equal(result.get('book').eligibility, 'runbook');
});
