const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./fixture.cjs');
const { correlation } = require('./egress.cjs');
async function harness(count = 1, observe = false) {
  const events = []; let client; let hooks;
  const { createOpencodeClient } = await import('@opencode-ai/sdk');
  const input = { client: createOpencodeClient({ baseUrl: 'http://inert.invalid', fetch: async (request) => {
    if (new URL(request.url).pathname === '/session') return Response.json({ id: 'child' });
    assert.equal(new URL(request.url).pathname, '/session/child/message');
    for (let index = 0; index < count; index++) await hooks.observedProvider('https://synthetic.invalid',
      { headers: { [correlation]: 'child' } }, async () => new Response('', { headers: { 'x-memocap-dispatch-id': `d${index}` } }));
    if (observe) {
      await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
        id: 'tool-part', sessionID: 'child', messageID: 'generation', type: 'tool', state: { input: { secret: 'excluded' } } } } } });
      const completion = { event: { type: 'message.updated', properties: { info: {
        id: 'generation', sessionID: 'child', parentID: 'child-user', role: 'assistant', finish: 'tool-calls',
        time: { created: 1, completed: 200 }, tokens: { input: 90, output: 12 }, error: { name: 'APIError', data: { message: 'excluded' } } } } } };
      await hooks.event(completion); await hooks.event(structuredClone(completion));
    }
    return Response.json({ info: { id: 'answer', sessionID: 'child', role: 'assistant', finish: 'stop', time: { created: 201, completed: 206 },
      tokens: { input: observe ? 0 : 10, output: observe ? 0 : 2, reasoning: observe ? 0 : 1, cache: { read: observe ? 0 : 8, write: 0 } } },
       parts: [{ type: 'text', text: observe ? '' : '{}' }] });
   } }) };
  hooks = await createFixture(input, { binding() {}, charge() {}, writeCarrier() {},
    factory: async (projected) => { client = projected.client; return {}; } });
  hooks.bind({ operations: [] }, { user() {}, complete() {}, reviewAllowed: () => true, charge() {}, record: (event) => events.push(event) });
  await hooks['chat.message']({ sessionID: 'root' }, { message: { id: 'user' }, parts: [] });
  await client.session.create({ body: { parentID: 'root', title: 'memocap capture extract' } });
  return { events, client, hooks };
}
test('public fixture does not infer SDK usage attribution from a single pending transport', async () => {
  const current = await harness(); await current.client.session.prompt({ path: { id: 'child' }, body: {} });
  const response = current.events.find(({ kind }) => kind === 'model.response');
  assert.equal(response.dispatch_id, null); assert.equal(response.session, 'child');
  assert.deepEqual(response.usage.tokens, { input: 10, output: 2, reasoning: 1, cache_read: 8, cache_write: 0 });
});
test('aggregated SDK prompt cannot fabricate per-dispatch usage for multiple transport responses', async () => {
  const current = await harness(2); await current.client.session.prompt({ path: { id: 'child' }, body: {} });
  assert.equal(current.events.find(({ kind }) => kind === 'model.response').dispatch_id, null);
  assert.equal(current.events.filter(({ kind }) => kind === 'provider.link').length, 2);
});
test('root assistant completion projects one response usage and never duplicates it on repeated events', async () => {
  const current = await harness();
  await current.hooks.observedProvider('https://synthetic.invalid', { headers: { [correlation]: 'root' } },
    async () => new Response('', { headers: { 'x-memocap-dispatch-id': 'parent-dispatch' } }));
  const event = { event: { type: 'message.updated', properties: { info: { id: 'parent-answer', sessionID: 'root', parentID: 'user',
    role: 'assistant', finish: 'stop', time: { completed: 3 }, tokens: { input: 12, output: 3 } } } } };
  await current.hooks.event(event); await current.hooks.event(structuredClone(event));
  const responses = current.events.filter(({ kind }) => kind === 'model.parent.response');
  assert.equal(responses.length, 1); assert.equal(responses[0].dispatch_id, null);
  assert.equal(responses[0].usage.tokens.input, 12);
});
test('owned generation completion and distinct empty zero-token SDK reply retain separate safe provenance', async () => {
  const current = await harness(1, true);

  await current.client.session.prompt({ path: { id: 'child' }, body: {} });

  const reply = current.events.find(({ kind }) => kind === 'model.response');
  const completions = current.events.filter(({ kind }) => kind === 'model.completion');
  assert.equal(reply.source, 'sdk_returned'); assert.equal(reply.message, 'answer');
  assert.equal(reply.usage.tokens.input, 0); assert.equal(reply.usage.latency_ms, 5);
  assert.equal(reply.dispatch_id, null);
  assert.equal(reply.text, '');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].source, 'observed_completion');
  assert.equal(completions[0].message, 'generation'); assert.equal(completions[0].usage.tokens.input, 90);
  assert.equal(completions[0].dispatch_id, null);
  assert.deepEqual(completions[0].metadata, { message: 'generation', session: 'child', finish: 'tool-calls',
    error_category: 'APIError', created: 1, completed: 200, part_types: ['tool'] });
  assert.equal(Object.hasOwn(completions[0], 'text'), false);
  assert.equal(Object.hasOwn(completions[0].metadata, 'error'), false);
});
test('foreign and stale child completions cannot acquire the current review owner', async () => {
  const current = await harness();
  const event = { event: { type: 'message.updated', properties: { info: { id: 'late', sessionID: 'child',
    role: 'assistant', time: { created: 1, completed: 2 }, tokens: { input: 10 } } } } };
  current.hooks.bind({ operations: [] }, { user() {}, charge() {}, record: (entry) => current.events.push(entry) });
  await current.hooks['chat.message']({ sessionID: 'root' }, { message: { id: 'next-user' }, parts: [] });

  await current.hooks.event(event);
  await current.hooks.event({ event: { type: 'message.updated', properties: { info: { ...event.event.properties.info, sessionID: 'foreign' } } } });

  assert.equal(current.events.filter(({ kind }) => kind === 'model.completion').length, 0);
});
test('completion observation does not charge an additional generation for a distinct SDK terminal message', async () => {
  const current = await harness(1, true);
  await current.client.session.prompt({ path: { id: 'child' }, body: {} });
  const completion = { event: { type: 'message.updated', properties: { info: { role: 'assistant', sessionID: 'child',
    time: { created: 201, completed: 206 }, tokens: { input: 0, output: 0 } } } } };

  for (const id of ['second', 'third', 'sdk-terminal']) {
    await current.hooks.event({ event: { ...completion.event, properties: { info: { ...completion.event.properties.info, id } } } });
  }

  assert.equal(current.events.filter(({ kind }) => kind === 'model.completion').length, 4);
  assert.equal(current.events.find(({ message }) => message === 'sdk-terminal').dispatch_id, null);
});
