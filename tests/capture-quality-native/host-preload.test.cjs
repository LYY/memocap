const test = require('node:test');
const assert = require('node:assert/strict');
const { startHost, fixtureURL } = require('./host.cjs');
const { SharedBudget } = require('./journal.cjs');
const { memoryIO, processFake } = require('./fakes.cjs');
const { fakePreload } = require('./preload-decision.test-support.cjs');
const { diagnostics } = require('./diagnostics.cjs');

const paths = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'tmp', 'project']
  .map((name) => [name, `/owned/${name}`]));
const approval = { batch: 'offline', sandbox: { path: '/sandbox' }, policy: { path: '/policy' },
  preflight_policy: { path: '/pure-policy' }, host: { path: '/fake-host' } };
const options = (pure = false) => ({ input: { profileRef: '/synthetic-profile', privateRoot: '/owned' },
  approval, paths, pure, budget: SharedBudget.consume('/attempt', { batch: 'offline' }, { io: memoryIO() }) });
const client = (config) => ({ _client: { get: async () => ({ data: { version: '1.19.5' } }) },
  config: { get: async () => ({ data: config }) }, mcp: { status: async () => ({ data: {} }) } });

for (const pure of [true, false]) test(`missing optional origins permit exact public configuration with audited ${pure ? 'pure' : 'task'} preload`, async () => {
  const log = [];
  const settings = options(pure);
  const host = await startHost(settings, { spawn: processFake(log), fetch: async () => new Response(''),
    preloadCheck: (request) => {
      const derived = fakePreload(request);
      assert.equal(derived.reads.includes('/synthetic-never-opened'), false);
      return derived.proof;
    }, clientFactory: () => client({ plugin: pure ? [] : [fixtureURL], mcp: {} }) });
  await host.close();
  const events = settings.budget.snapshot().events;
  const pre = events.findIndex((event) => event.kind === 'host.preload');
  const post = events.findIndex((event) => event.kind === 'host.isolation');
  assert.ok(pre >= 0 && post > pre);
  assert.equal(events[pre].decision.source_commit, '810c0eba1a7348036f8bdf61e6632d0c36c6876c');
  assert.equal(events[post].observation.origins.presence, 'unavailable');
  assert.equal(events[post].observation.origins.count, null);
  assert.equal(events[post].observation.isolation, 'audited_preload_and_public_match');
});

test('absence alone and caller-authored preload booleans cannot replace missing provenance', () => {
  const observation = { status: 200, result: { data: { plugin: [fixtureURL], mcp: {} } }, mcpStatus: { data: {} } };
  assert.equal(diagnostics(observation, [fixtureURL]).isolation, 'unknown');
  assert.equal(diagnostics({ ...observation, preload: { status: 'source_supported', approved: true } }, [fixtureURL]).isolation, 'unknown');
});

for (const [name, mutate] of [
  ['managed JSON', (_settings, deps) => { deps.io.existsSync = (file) => file === '/Library/Application Support/opencode/opencode.json'; }],
  ['managed JSONC', (_settings, deps) => { deps.io.existsSync = (file) => file === '/Library/Application Support/opencode/opencode.jsonc'; }],
  ['managed user plist', (_settings, deps) => { deps.io.existsSync = (file) => file === '/Library/Managed Preferences/liuyuyu/ai.opencode.managed.plist'; }],
  ['managed shared plist', (_settings, deps) => { deps.io.existsSync = (file) => file === '/Library/Managed Preferences/ai.opencode.managed.plist'; }],
  ['changed profile', (settings) => { settings.approval.profile_sha256 = 'changed'; }],
  ['changed host', (_settings, deps) => { deps.artifactHash = () => 'changed'; }],
  ['changed fixture', (settings) => { settings.approval.implementation = 'changed'; }],
  ['changed HOME', (settings) => { settings.env.HOME = '/foreign'; }],
  ['project discovery enabled', (settings) => { settings.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'false'; }],
  ['default discovery enabled', (settings) => { settings.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'false'; }],
  ['inherited auth source', (settings) => { settings.env.OPENCODE_AUTH_CONTENT = 'WITHHELD'; }],
  ['unexpected inline plugin', (settings) => { settings.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: ['other'], mcp: {} }); }],
  ['unexpected inline MCP', (settings) => { settings.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [fixtureURL], mcp: { other: {} } }); }],
  ['private auth storage', (settings, deps) => { deps.io.existsSync = (file) => file === `${settings.paths.data}/opencode/auth.json`; }],
  ['changed config directory', (settings) => { settings.paths = { ...settings.paths, config: '/foreign' }; }],
  ['directory recheck failure', (settings) => { settings.preparation = { recheck: () => { throw new Error('withheld'); } }; }],
]) {
  test(`preload blocks ${name} before any fake spawn or generation`, async () => {
    const log = [];
    const settings = options();
    await assert.rejects(() => startHost(settings, { spawn: processFake(log),
      preloadCheck: (request) => fakePreload(request, mutate).proof,
      clientFactory: () => assert.fail('must not reach HTTP') }));
    assert.equal(log.length, 0);
    assert.equal(settings.budget.snapshot().dispatches, 0);
  });
}

test('a caller-authored preload result cannot authorize a fake host spawn', async () => {
  const log = [];
  await assert.rejects(() => startHost(options(), { spawn: processFake(log),
    preloadCheck: () => ({ status: 'source_supported', identities: [fixtureURL] }) }), { code: 'preload_preparation_required' });
  assert.equal(log.length, 0);
});

for (const statuses of [undefined, [], { extra: { status: 'connected', url: 'WITHHELD' } }]) {
  test('native MCP status must independently agree with the empty public configuration', async () => {
    const log = [];
    const settings = options();
    const observed = client({ plugin: [fixtureURL], mcp: {} });
    observed.mcp.status = async () => ({ data: statuses });
    await assert.rejects(() => startHost(settings, { spawn: processFake(log), fetch: async () => new Response(''),
      preloadCheck: (request) => fakePreload(request).proof, clientFactory: () => observed }), { code: 'isolation_unknown' });
    assert.equal(settings.budget.snapshot().dispatches, 0);
    assert.equal(JSON.stringify(settings.budget.snapshot()).includes('WITHHELD'), false);
  });
}

for (const [name, config] of [
  ['extra public plugin', { plugin: [fixtureURL, 'https://other.invalid/?token=WITHHELD'], mcp: {} }],
  ['wrong public plugin type', { plugin: {}, mcp: {} }],
  ['wrong public identity', { plugin: [], mcp: {} }],
  ['configured MCP', { plugin: [fixtureURL], mcp: { extra: { type: 'remote', url: 'WITHHELD' } } }],
  ['wrong origin type', { plugin: [fixtureURL], plugin_origins: {}, mcp: {} }],
  ['contradictory origins', { plugin: [fixtureURL], plugin_origins: [], mcp: {} }],
  ['extra origins', { plugin: [fixtureURL], plugin_origins: [{ spec: fixtureURL, scope: 'local', source: 'OPENCODE_CONFIG_CONTENT' },
    { spec: 'other', scope: 'global', source: 'WITHHELD' }], mcp: {} }],
  ['tuple origin options', { plugin: [fixtureURL], plugin_origins: [{ spec: [fixtureURL, {}], scope: 'local', source: 'OPENCODE_CONFIG_CONTENT' }], mcp: {} }],
]) {
  test(`audited preload cannot hide ${name} before generation`, async () => {
    const log = [];
    const settings = options();
    await assert.rejects(() => startHost(settings, { spawn: processFake(log), fetch: async () => new Response(''),
      preloadCheck: (request) => fakePreload(request).proof, clientFactory: () => client(config) }), { code: 'isolation_unknown' });
    assert.equal(settings.budget.snapshot().dispatches, 0);
    assert.equal(log.includes('SIGTERM'), true);
    assert.equal(JSON.stringify(settings.budget.snapshot()).includes('WITHHELD'), false);
  });
}
