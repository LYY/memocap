const assert = require('node:assert/strict');
const test = require('node:test');
const { accessHost } = require('./plugin-access-fixture.cjs');
const host = (config) => accessHost({ config });

test('automatic true cannot grant library reads when the exact persistent leaf is missing', async () => {
  const current = await host({ permission: { '*': 'allow', memocap_recall: 'allow' } });
  const part = await current.transform();
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'recall'), false);
  assert.equal(part.metadata.memocap.status, 'blocked');
  assert.equal(part.metadata.memocap.error.code, 'library_grant_required');
  assert.equal(current.asks.length, 0);
});

test('last matching session rules override agent rules and invalidate a populated cache', async () => {
  const current = await host();
  await current.transform();
  current.session.permission.push({ permission: 'memocap_recall', pattern: '*', action: 'deny' });
  const denied = await current.transform();
  assert.equal(denied.metadata.memocap.status, 'blocked');
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'recall').length, 1);
  current.session.permission.push({ permission: 'memocap_recall', pattern: 'library', action: 'allow' });
  const granted = await current.transform();
  assert.deepEqual(granted.metadata.memocap.injected_ids, [1]);
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'recall').length, 2);
});

test('an optional space-star deny invalidates a populated read cache and prevents native ask', async () => {
  const current = await host();
  await current.transform();
  current.session.permission.push({ permission: 'memocap_recall *', pattern: 'library *', action: 'deny' });

  const part = await current.transform();

  assert.equal(part.metadata.memocap.error.code, 'permission_deny');
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'recall').length, 1);
  assert.equal((await current.execute('recall', { query: 'release' })).status, 'denied');
  assert.equal(current.asks.length, 0);
});

test('native recall denial blocks same-session auto reads across new input and compaction', async () => {
  const current = await host();
  current.context.ask = async () => { throw new Error('native rejection'); };
  const denied = JSON.parse((await current.tools.memocap_recall.execute({ query: 'release' }, current.context)).output);
  assert.equal(denied.status, 'denied');
  await current.runtime.compact({ sessionID: 'A' });
  const part = await current.transform();
  assert.equal(part.metadata.memocap.status, 'blocked');
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'recall'), false);
  current.session.permission.push({ permission: 'memocap_recall', pattern: 'library', action: 'allow' });
  assert.deepEqual((await current.transform()).metadata.memocap.injected_ids, [1]);
});

test('explicit recall asks the native library capability and retains its exact origin selector', async () => {
  const current = await host();
  const { memory } = require('./plugin-fixture.cjs');
  const placements = ['universal', memory().memory.placement];
  const result = JSON.parse((await current.tools.memocap_recall.execute({ query: 'release', placements }, current.context)).output);
  assert.equal(result.status, 'ok');
  assert.equal(current.asks[0].permission, 'memocap_recall');
  assert.deepEqual(current.asks[0].patterns, ['library']);
  assert.deepEqual(current.asks[0].metadata.discovery, { kind: 'origins', placements });
  const call = current.calls.find(({ argv }) => argv[0] === 'recall').argv;
  assert.deepEqual(call.flatMap((arg, index) => arg === '--placement' ? [call[index + 1]] : []), placements);
  assert.equal(call.includes('--library'), false);
});

test('unparseable current host rules stop automatic retrieval without prompting', async () => {
  const current = await host();
  current.session.permission = { memocap_recall: 'allow' };
  const part = await current.transform();
  assert.equal(part.metadata.memocap.error.code, 'permission_unavailable');
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'recall'), false);
  assert.equal(current.asks.length, 0);
});

test('an effective read tool deny cannot be bypassed through the library ask permission', async () => {
  const current = await host();
  current.session.permission.push({ permission: 'memocap_read', pattern: '*', action: 'deny' });
  const result = await current.execute('read', { id: 9, placement: 'universal' });
  assert.equal(result.status, 'denied');
  assert.equal(current.asks.length, 0);
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'read'), false);
});

test('automatic ask does not prompt and an effective recall deny prevents an explicit ask', async () => {
  const current = await host();
  current.session.permission.push({ permission: 'memocap_recall', pattern: 'libr?ry', action: 'ask' });
  assert.equal((await current.transform()).metadata.memocap.error.code, 'permission_ask');
  current.session.permission.push({ permission: 'memocap_*', pattern: '*', action: 'deny' });
  assert.equal((await current.execute('recall', { query: 'release' })).status, 'denied');
  assert.equal(current.asks.length, 0);
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'recall'), false);
});

test('a command with no native ToolContext requires the persistent exact grant', async () => {
  const current = await host({ permission: { '*': 'allow' } });
  await assert.rejects(current.operations.recall({ query: 'release' }, { sessionID: 'A', agent: 'build' }),
    { code: 'library_grant_required' });
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'recall'), false);
});

test('default library selection is explicit on the wire and an origin filter survives subsequent recall', async () => {
  const current = await host();
  await current.execute('recall', { query: 'release' });
  assert.equal(current.calls.find(({ argv }) => argv[0] === 'recall').argv.includes('--library'), true);
  await current.execute('recall', { query: 'release', placements: ['universal'] });
  await current.execute('recall', { query: 'release' });
  const argv = current.calls.filter(({ argv }) => argv[0] === 'recall').at(-1).argv;
  assert.equal(argv[argv.indexOf('--placement') + 1], 'universal');
  assert.equal(argv.includes('--library'), false);
});

test('null session permission is unavailable rather than an empty host ruleset', async () => {
  const current = await host();
  current.session.permission = null;
  const part = await current.transform();
  assert.equal(part.metadata.memocap.error.code, 'permission_unavailable');
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'recall'), false);
});

test('unrelated host configuration changes cannot release a native rejection latch', async () => {
  const current = await host();
  current.context.ask = async () => { throw new Error('native rejection'); };
  await current.execute('recall', { query: 'release' });
  current.rules.push({ permission: 'bash', pattern: '*', action: 'allow' });
  const part = await current.transform();
  assert.equal(part.metadata.memocap.error.code, 'native_permission_denied');
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'recall'), false);
});

test('a new input while native read approval is pending prevents the stale exact read', async () => {
  const { user } = require('./plugin-fixture.cjs');
  const current = await host();
  current.context.ask = async () => {
    const message = user('A', 'new-input', 'new task');
    await current.runtime.capture({ sessionID: 'A' }, { message: message.info, parts: message.parts });
  };
  const result = await current.execute('read', { id: 9, placement: 'universal' });
  assert.equal(result.status, 'failed');
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'read'), false);
});
