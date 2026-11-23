const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { fixturePermissions } = require('./permission-configuration.cjs');
const { lifecycleProbe } = require('./lifecycle-probe.cjs');
const { size } = require('./value.cjs');
const origin = `repository:${'b'.repeat(64)}`;

function match(value, pattern) {
  const escaped = pattern.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 's').test(value.replaceAll('\\', '/'));
}
function evaluate(rules, permission, pattern) {
  return rules.findLast((rule) => match(permission, rule.permission) && match(pattern, rule.pattern))?.action ?? 'ask';
}
const packet = (root, input = {}) => ({ user: 'Synthetic task', operations: [
  { tool: 'read', input: { filePath: `${root}/source.txt`, ...input } },
] });

for (const [name, worktree, root] of [
  ['nested project', '/synthetic/worktree', '/synthetic/worktree/project'],
  ['linked Instance worktree', '/synthetic/linked', '/synthetic/linked/project'],
]) for (const input of [{}, { offset: 3, limit: 2 }]) {
  test(`ReadTool relative ask allows only its owned source: ${name}, ${JSON.stringify(input)}`, async () => {
    const configured = await fixturePermissions('read-route', { root, worktree, origin }, []);
    const operation = packet(root, input);
    const rules = configured.root(operation);
    const absolute = path.resolve(root, operation.operations[0].input.filePath);
    assert.equal(evaluate(rules, 'read', path.relative(worktree, absolute)), 'allow');
    for (const file of [`${root}/unrelated.txt`, `${root}/source.txt.extra`, `${root}/other/source.txt`, '/synthetic/main/project/source.txt']) {
      assert.equal(evaluate(rules, 'read', path.relative(worktree, file)), 'deny');
    }
    assert.equal(evaluate(rules, 'external_directory', '/foreign/*'), 'deny');
    assert.deepEqual(operation, packet(root, input));
  });
}

for (const worktree of [undefined, '', 'relative', '/foreign', '/synthetic/../synthetic', '/synthetic/*']) {
  test(`generator rejects invalid Instance worktree ${String(worktree)}`, async () => {
    const configured = await fixturePermissions('read-route', { root: '/synthetic/project', worktree, origin }, []);
    assert.throws(() => configured.root(packet('/synthetic/project')), { code: 'native_instance_path_invalid' });
  });
}

test('generator rejects sources outside the owned directory and wildcard-bearing paths', async () => {
  const configured = await fixturePermissions('read-route', { root: '/synthetic/project', worktree: '/synthetic', origin }, []);
  for (const filePath of ['/synthetic/other/source.txt', '/foreign/source.txt', '/synthetic/project/*.txt', '/synthetic/project/a?.txt']) {
    assert.throws(() => configured.root(packet('/synthetic/project', { filePath })), { code: 'native_source_path_invalid' });
  }
});

test('public concrete caller uses and meters Instance path before generating relative root rules', async () => {
  const probe = lifecycleProbe({ worktree: '/synthetic' });
  try {
    const location = await probe.open();
    assert.equal(location.worktree, '/synthetic');
    assert.equal(probe.pathRequests.length, 1);
    assert.equal(probe.pathRequests[0].query.directory, '/synthetic/private/project');
    assert.ok(probe.pathRequests[0].signal instanceof AbortSignal);
    assert.equal(probe.charges.filter(([key]) => key === 'sdk_requests').length, 3);
    assert.ok(probe.charges.some(([key, amount]) => key === 'total_bytes' && amount === size([probe.pathRequests[0]])));
    assert.ok(probe.charges.some(([key, amount]) => key === 'total_bytes' &&
      amount === size({ data: { directory: location.root, worktree: location.worktree } })));
    await probe.host.deliver(packet(location.root), { charge() {} }, { signal: new AbortController().signal });
    assert.equal(evaluate(probe.rules.at(-1), 'read', 'private/project/source.txt'), 'allow');
    assert.equal(evaluate(probe.rules.at(-1), 'read', 'private/project/other.txt'), 'deny');
  } finally { await probe.host.close({}); }
});

for (const data of [{ directory: '/synthetic/private/project' }, { directory: '/synthetic/private/project', worktree: 'relative' },
  { directory: '/wrong', worktree: '/synthetic' }, { directory: '/synthetic/private/project', worktree: '/foreign' }]) {
  test(`bootstrap refuses invalid Instance response ${JSON.stringify(data)}`, async () => {
    const probe = lifecycleProbe({ instanceResponse: { data } });
    try {
      await assert.rejects(probe.open(), { code: 'native_instance_path_invalid' });
      assert.deepEqual(probe.rules, []);
      assert.equal(probe.events.includes('plugin.initialize'), false);
    } finally { await probe.host.close({}); }
  });
}

for (const [instanceResponse, code] of [[{ error: { message: 'in-memory failure' } }, 'native_instance_path_invalid'],
  [{ data: { directory: '/synthetic/private/project', worktree: '/synthetic', extra: 'x'.repeat(131072) } }, 'sdk_response_bytes']]) {
  test(`bootstrap refuses ${code} before native initialization or root grant`, async () => {
    const probe = lifecycleProbe({ instanceResponse });
    try {
      await assert.rejects(probe.open(), { code });
      assert.deepEqual(probe.rules, []);
      assert.equal(probe.events.includes('plugin.initialize'), false);
    } finally { await probe.host.close({}); }
  });
}

test('installed SDK public path.get sends scoped GET /path with the declared response', async () => {
  const { createOpencodeClient } = await import('@opencode-ai/sdk');
  const observed = [];
  const client = createOpencodeClient({ baseUrl: 'http://in-memory.invalid', fetch: async (request) => {
    observed.push(request);
    return Response.json({ state: '/synthetic/state', config: '/synthetic/config',
      directory: '/synthetic/linked/project', worktree: '/synthetic/linked' });
  } });
  const result = await client.path.get({ query: { directory: '/synthetic/linked/project' } });
  assert.equal(result.data.worktree, '/synthetic/linked');
  assert.equal(observed[0].method, 'GET');
  assert.equal(new URL(observed[0].url).pathname, '/path');
  assert.equal(new URL(observed[0].url).searchParams.get('directory'), '/synthetic/linked/project');
});
