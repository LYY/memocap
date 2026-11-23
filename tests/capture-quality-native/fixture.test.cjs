const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./fixture-core.cjs');
const { SharedBudget } = require('./journal.cjs');
const { memoryIO } = require('./fakes.cjs');
const { correlation } = require('./provider.cjs');
const { fixtures } = require('./controller.cjs');
const { digest } = require('./projection.cjs');

async function fixture({ denied = false, active = null } = {}) {
  const io = memoryIO();
  const budget = SharedBudget.consume('/attempt', { batch: 'test', fingerprint: 'digest' }, { io });
  budget.host('nonpure'); budget.root('root', 'user', active?.slot ?? null);
  if (active) budget.change((state) => { state.active = active; });
  const sent = [];
  const target = { fetch: async (request) => { sent.push(request); return new Response('', { status: 200 }); } };
  const original = target.fetch;
  let asked = 0;
  let factoryCalls = 0;
  let adapted;
  let childCalls = 0;
  const input = { serverUrl: new URL('http://127.0.0.1:8123'), client: { session: {
    create: async () => ({ data: { id: ++childCalls === 1 ? 'child' : `child-${childCalls}` } }),
    prompt: async () => ({ data: { info: { finish: 'stop' }, parts: [] } }),
  } } };
  const hooks = await createFixture(input, { budget, fetchTarget: target, clean: () => true,
    settings: { providerDestinations: ['https://provider.invalid/responses'], authDestinations: [], contract: fixtures().contract },
    factory: async (value) => { adapted = value; factoryCalls++; return { tool: { memocap_remember: { execute: async (_args, context) => {
      await context.ask({ permission: 'memocap_remember' });
      return { output: JSON.stringify({ status: 'inserted', returned_ids: [1] }) };
    } } } }; },
  });
  const context = { sessionID: 'child', messageID: 'commit-message', ask: async () => {
    asked++; if (denied) throw new Error('private denial details');
  } };
  return { hooks, target, original, budget, sent, input, context, factoryCalls, adapted,
    asked: () => asked, childCalls: () => childCalls };
}

test('a third child is refused before its SDK creation and factory errors restore the fetch binding', async () => {
  const current = await fixture();
  const create = () => current.adapted.client.session.create({ body: { parentID: 'root', title: 'memocap capture extract' } });
  await create(); await create();
  await assert.rejects(create, { code: 'review_child_budget' });
  assert.equal(current.childCalls(), 2);
  await current.hooks.dispose();
  const target = { fetch: current.original };
  await assert.rejects(() => createFixture(current.input, { budget: current.budget, fetchTarget: target,
    settings: { providerDestinations: [], authDestinations: [] }, clean: () => true,
    factory: async () => { throw new Error('offline factory failure'); } }));
  assert.equal(target.fetch, current.original);
});

test('root hooks accept only the original controller-delivered native user parts', async () => {
  const current = await fixture();
  current.budget.change((state) => { state.delivery = { session: 'other-root', user_hash: digest('original task') }; });
  await current.hooks['chat.message']({ sessionID: 'other-root' }, {
    message: { id: 'genuine-user' }, parts: [{ type: 'text', text: 'original task' }] });
  assert.equal(current.budget.snapshot().roots['other-root'], 'other-root:genuine-user');
  await assert.rejects(() => current.hooks['chat.message']({ sessionID: 'other-root' }, {
    message: { id: 'unexpected-user' }, parts: [{ type: 'text', text: 'different task' }] }), { code: 'unexpected_root_input' });
  await current.hooks.dispose();
});

test('uncertain SDK child creation and prompt outcomes stop the shared batch', async () => {
  const first = await fixture();
  first.input.client.session.create = async () => { throw new Error('WITHHELD'); };
  await assert.rejects(() => first.adapted.client.session.create({ body: { parentID: 'root', title: 'memocap capture extract' } }),
    { code: 'child_creation_uncertain' });
  assert.equal(first.budget.snapshot().terminal, 'child_creation_uncertain');
  await first.hooks.dispose();
  const second = await fixture();
  await second.adapted.client.session.create({ body: { parentID: 'root', title: 'memocap capture extract' } });
  second.input.client.session.prompt = async () => { throw new Error('WITHHELD'); };
  await assert.rejects(() => second.adapted.client.session.prompt({ path: { id: 'child' }, body: {
    parts: [{ type: 'text', text: '{"sources":[],"bundles":[]}' }] } }), { code: 'dispatch_uncertain' });
  assert.equal(JSON.stringify(second.budget.snapshot()).includes('WITHHELD'), false);
  await second.hooks.dispose();
});

test('native fixture uses the current module shape and installs an executable options.fetch', async () => {
  const module = await import('./fixture.mjs');
  const current = await fixture();
  const config = { provider: { 'openai-b1': { options: {} } } };
  await current.hooks.config(config);
  await current.hooks['chat.headers']({ sessionID: 'root' }, { headers: {} });
  await config.provider['openai-b1'].options.fetch('https://provider.invalid/responses', {
    headers: { [correlation]: 'root', authorization: 'private synthetic token' } });
  assert.equal(module.default.server, createFixture);
  assert.equal(current.factoryCalls, 1);
  assert.equal(current.budget.snapshot().dispatches, 1);
  assert.equal(current.sent[0].headers.has(correlation), false);
  await current.hooks.dispose();
  assert.equal(current.target.fetch, current.original);
});

test('fourth actual provider attempt in a native review never reaches transport', async () => {
  const current = await fixture();
  await current.hooks.config({ provider: { native: { options: {} } } });
  current.budget.child('child', 'root', 'extract');
  const config = { provider: { native: { options: {} } } };
  await current.hooks.config(config);
  const send = () => config.provider.native.options.fetch('https://provider.invalid/responses', { headers: { [correlation]: 'child' } });
  await send(); await send(); await send();
  await assert.rejects(send, { code: 'review_dispatch_budget' });
  assert.equal(current.sent.length, 3);
  await current.hooks.dispose();
});

test('tool wrapper delegates the host ask and keeps real message identity', async () => {
  const current = await fixture();
  current.budget.child('child', 'root', 'commit');
  await current.hooks.tool.memocap_remember.execute({}, current.context);
  const events = current.budget.snapshot().events;
  assert.equal(current.asked(), 1);
  assert.deepEqual(events.find((event) => event.kind === 'native.ask'), { kind: 'native.ask', session: 'child',
    message: 'commit-message', permission: 'memocap_remember', proposal_id: null, outcome: 'resolved' });
  assert.equal(events.find((event) => event.kind === 'tool.receipt').root, 'root');
  await current.hooks.dispose();
});

test('actual ask rejection stops every subsequent provider attempt without leaking its error', async () => {
  const current = await fixture({ denied: true });
  current.budget.child('child', 'root', 'commit');
  await assert.rejects(() => current.hooks.tool.memocap_remember.execute({}, current.context));
  assert.equal(current.budget.snapshot().terminal, 'permission_denied');
  assert.equal(JSON.stringify(current.budget.snapshot()).includes('private denial details'), false);
  await current.hooks.dispose();
});

test('support injection changes only actual first-stage text and leaves native finish untouched', async () => {
  const { contract } = fixtures();
  const challenge = contract.counterfactuals.find((item) => item.name === 'drop_conditions');
  const current = await fixture({ active: { slot: challenge.name, challenge, user_hash: digest('original user') } });
  let adapted;
  const hooks = await createFixture(current.input, { budget: current.budget, fetchTarget: { fetch: current.original }, clean: () => true,
    settings: { providerDestinations: [], authDestinations: [], contract }, factory: async (input) => { adapted = input; return {}; } });
  await adapted.client.session.create({ body: { parentID: 'root', title: 'memocap capture extract' } });
  const binding = contract.bindings.dropped_short;
  const packet = { current_user_id: 'user', sources: [
    { source_id: 'native-user-part', user_id: 'user', kind: 'user_statement', text: 'original user' },
    { source_id: 'native-read-part', user_id: 'user', completeness: 'full',
      text: 'For alpha, start at docs/alpha.md. Approval required. Never use for beta.', content_hash: binding.content_hash }],
  bundles: [{ source_id: 'native-read-part', user_id: 'user', units: [{ content_hash: binding.content_hash, span: { start: 0, end: 73 } }] }] };
  const reply = await adapted.client.session.prompt({ path: { id: 'child' }, body: { parts: [{ type: 'text', text: JSON.stringify(packet) }] } });
  const output = { text: 'synthetic original first-stage response' };
  await hooks['experimental.text.complete']({ sessionID: 'child', messageID: 'native-result', partID: 'native-text' }, output);
  assert.equal(JSON.parse(output.text).candidates[0].statements[0].citations[0].source_id, 'native-read-part');
  assert.equal(reply.data.info.finish, 'stop');
  await adapted.client.session.prompt({ path: { id: 'child' }, body: { parts: [{ type: 'text', text: '{}' }] } });
  assert.equal(current.budget.snapshot().sessions.child.stage, 'support');
  await assert.rejects(() => adapted.client.session.create({ body: { parentID: 'root', title: 'memocap capture commit' } }),
    { code: 'support_only_zero_writes' });
  assert.equal(current.budget.snapshot().writes, 0);
  await hooks.dispose();
  await current.hooks.dispose();
});
