const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { fixture, receipt, memory, user, repoPath, repoID, resolvedTarget } = require('./plugin-fixture.cjs');

async function host(options = {}) {
  const base = fixture();
  const { createRecallRuntime } = await import('../plugin/recall.js');
  const { createOperations } = await import('../plugin/operations.js');
  const { createTools } = await import('../plugin/tools.js');
  const { createCommands } = await import('../plugin/commands.js');
  const rows = [];
  let failPath;
  let auxiliaryFailure = false;
  const runtime = createRecallRuntime(base.input, options, async (argv, requestOptions) => {
    if (argv.includes(failPath)) throw Object.assign(new Error('fixture failure'), { code: 'cli_failed' });
    const answer = await base.run(argv, requestOptions);
    if (auxiliaryFailure) Object.assign(answer.receipt, { activity_status: 'failed', warning: 'auxiliary unavailable' });
    if (argv[0] === 'remember') {
      rows.push(argv.at(argv.indexOf('--') + 1));
      answer.receipt = receipt('remember', { status: 'inserted', results: [], returned_ids: [rows.length],
        searched_placements: ['repository:A'] });
    }
    if (argv[0] === 'list') {
      const entries = options.inventory ? options.inventory(argv) : rows.map((content, index) => memory(index + 1, content));
      answer.receipt = receipt('list', { results: entries, returned_ids: entries.map((entry) => entry.memory.id) });
    }
    return answer;
  });
  const operations = createOperations(runtime);
  const tools = createTools(operations);
  const commands = createCommands(operations, runtime);
  const askCalls = [];
  const context = { sessionID: 'A', messageID: 'tool-msg', directory: repoPath('A'), worktree: repoPath('A'),
    abort: new AbortController().signal, ask: async (permission) => { askCalls.push(permission); }, metadata() {} };
  return { ...base, runtime, tools, commands, context, rows, askCalls, fail: (path) => { failPath = path; },
    degrade: () => { auxiliaryFailure = true; } };
}

test('SDK scope tool resolves purely before permission and commits only after all target recalls succeed', async () => {
  const current = await host();
  current.context.ask = async () => { assert.deepEqual(current.calls.map(({ argv }) => argv.slice(0, 2)), [['scope', 'resolve']]); throw new Error('denied'); };
  const denied = JSON.parse((await current.tools.memocap_scope.execute({ paths: [repoPath('B')] }, current.context)).output);
  assert.equal(denied.status, 'denied');
  assert.deepEqual(current.calls.map(({ argv }) => argv.slice(0, 2)), [['scope', 'resolve']]);
  current.context.ask = async () => {};
  const message = user();
  await current.runtime.capture({ sessionID: 'A' }, { message: message.info, parts: message.parts });
  const switched = JSON.parse((await current.tools.memocap_scope.execute({ paths: [repoPath('B'), repoPath('C')] }, current.context)).output);
  assert.equal(switched.status, 'ok');
  assert.deepEqual((await current.runtime.context('A')).targets, [repoPath('B'), repoPath('C')].map(resolvedTarget));
  current.fail(repoPath('missing'));
  const failed = JSON.parse((await current.tools.memocap_scope.execute({ paths: [repoPath('A'), repoPath('missing')] }, current.context)).output);
  assert.equal(failed.status, 'failed');
  assert.deepEqual((await current.runtime.context('A')).targets, [repoPath('B'), repoPath('C')].map(resolvedTarget));
});

test('same query on new targets refreshes and auxiliary warnings keep successful scope', async () => {
  const current = await host();
  current.degrade();
  for (const path of [repoPath('B'), repoPath('C')]) {
    const answer = JSON.parse((await current.tools.memocap_scope.execute({ paths: [path], query: 'release' }, current.context)).output);
    assert.equal(answer.status, 'ok');
    assert.equal(answer.activity_status, 'failed');
    assert.equal(typeof answer.warning, 'string');
  }
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'recall').length, 2);
  assert.deepEqual((await current.runtime.context('A')).targets, [resolvedTarget(repoPath('C'))]);
});

test('manual scope seeds references even when automatic recall is disabled', async () => {
  const current = await host({ automatic: false });
  const message = user();
  await current.runtime.capture({ sessionID: 'A' }, { message: message.info, parts: message.parts });
  await current.tools.memocap_scope.execute({ paths: [repoPath('B')], query: 'other' }, current.context);
  await current.runtime.transform({}, { messages: [message] });
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'recall').length, 1);
  assert.deepEqual(message.parts.at(-1).metadata.memocap.targets, [repoID(repoPath('B'))]);
  assert.deepEqual(message.parts.at(-1).metadata.memocap.query_terms, ['other']);
});

test('remember uses one explicit target, structured fields and one write followed by independent readback', async () => {
  const current = await host();
  await current.tools.memocap_scope.execute({ paths: [repoPath('A'), repoPath('B')], query: 'release' }, current.context);
  const noPlacement = JSON.parse((await current.tools.memocap_remember.execute({ content: 'unsafe fanout' }, current.context)).output);
  assert.equal(noPlacement.status, 'failed');
  assert.equal(current.rows.length, 0);
  const content = 'quotes " $(touch forbidden)\nnext line';
  const saved = JSON.parse((await current.tools.memocap_remember.execute({ content, repository: repoPath('A'),
    type: 'decision', tags: ['release', 'cli'], topic: 'release-order' }, current.context)).output);
  assert.equal(saved.status, 'inserted');
  assert.equal(saved.readback.status, 'ok');
  assert.deepEqual(current.rows, [content]);
  const writes = current.calls.filter(({ argv }) => argv[0] === 'remember');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].argv[writes[0].argv.indexOf('--targets-json') + 1]), [resolvedTarget(repoPath('A'))]);
  assert.equal(writes[0].argv[writes[0].argv.indexOf('--') + 1], content);
  assert.ok(writes[0].argv.indexOf('--json') >= 0 && writes[0].argv.indexOf('--json') < writes[0].argv.indexOf('--'));
  assert.equal(writes[0].argv[writes[0].argv.indexOf('--tags') + 1], 'release,cli');
  assert.equal((await current.runtime.context('A')).cache, undefined);
});

test('denied recall and remember tools launch only pure scope resolution', async () => {
  for (const [name, args] of [['memocap_recall', { query: 'release' }], ['memocap_remember', { content: 'decision' }]]) {
    const current = await host();
    current.context.ask = async () => { throw new Error('permission denied'); };
    const answer = JSON.parse((await current.tools[name].execute(args, current.context)).output);
    assert.equal(answer.status, 'denied');
    assert.deepEqual(current.calls.map(({ argv }) => argv.slice(0, 2)), [['scope', 'resolve']]);
    assert.equal(current.rows.length, 0);
  }
});

test('command registration preserves user conflict and /memory commands render actual receipts', async () => {
  const current = await host();
  const custom = { template: 'user template', description: 'custom' };
  const config = { command: { memory: custom } };
  await current.commands.config(config);
  assert.equal(config.command.memory, custom);
  const output = { parts: [{ type: 'text', text: 'template placeholder' }] };
  await current.commands.execute({ command: 'memory', sessionID: 'A', arguments: 'status' }, output);
  assert.equal(current.calls.length, 0);
  const registered = await host();
  const fresh = {};
  await registered.commands.config(fresh);
  assert.equal(typeof fresh.command.memory.template, 'string');
  for (const raw of ['status', 'scopes', 'list repository:A 20', 'recent']) {
    const rendered = { parts: [{ type: 'text', text: fresh.command.memory.template }] };
    await registered.commands.execute({ command: 'memory', sessionID: 'A', arguments: raw }, rendered);
    const payload = JSON.parse(rendered.parts[0].text);
    assert.equal(payload.status, 'ok');
  }
  assert.deepEqual(registered.calls.map(({ argv }) => argv.slice(0, 2)),
    [['scope', 'resolve'], ['status', '--read-only'], ['scope', 'list'], ['list', '--placement'], ['activity', 'list']]);
});

test('command scope and recall share session targets while remember remains a permission-tool request', async () => {
  const current = await host();
  await current.commands.config({});
  const output = { parts: [] };
  await current.commands.execute({ command: 'memory', sessionID: 'A', arguments: `scope "${repoPath('B')}"` }, output);
  assert.deepEqual((await current.runtime.context('A')).targets, [resolvedTarget(repoPath('B'))]);
  const query = 'literal "quote" $(anything)\nsecond';
  await current.commands.execute({ command: 'memory', sessionID: 'A', arguments: `recall ${query}` }, output);
  const recall = current.calls.filter(({ argv }) => argv[0] === 'recall').at(-1);
  assert.deepEqual(JSON.parse(recall.argv[recall.argv.indexOf('--targets-json') + 1]), [resolvedTarget(repoPath('B'))]);
  await current.commands.execute({ command: 'memory', sessionID: 'A', arguments: `remember ${query}` }, output);
  const requested = JSON.parse(output.parts[0].text);
  assert.equal(requested.status, 'not_run');
  assert.equal(requested.tool, 'memocap_remember');
  assert.equal(requested.arguments.content, query);
  assert.equal(current.rows.length, 0);
});

test('relative tool targets use the actual session directory and freeze approval through execution', async () => {
  for (const [name, args] of [['memocap_scope', { paths: ['child'], query: 'release' }],
    ['memocap_remember', { repository: 'child', content: 'release decision' }]]) {
    const current = await host();
    const sessionDirectory = path.resolve('/session/B');
    const approvedChild = path.join(sessionDirectory, 'child');
    current.input.client.session.get = async () => ({ data: { directory: sessionDirectory } });
    current.context.directory = path.resolve('/host/A');
    current.context.ask = async (permission) => {
      assert.deepEqual(current.calls.map(({ argv }) => argv.slice(0, 2)), [['scope', 'resolve']]);
      assert.deepEqual(permission.patterns, [repoID(approvedChild)]);
      const state = await current.runtime.context('A');
      state.targets = [path.resolve('/unexpected')];
      if (args.paths) args.paths[0] = path.resolve('/mutated');
      else args.repository = path.resolve('/mutated');
    };
    const answer = JSON.parse((await current.tools[name].execute(args, current.context)).output);
    assert.ok(['ok', 'inserted'].includes(answer.status), JSON.stringify(answer));
    for (const { argv } of current.calls) {
      if (argv[0] === 'scope') assert.deepEqual(argv.flatMap((arg, index) => arg === '--repo' ? [argv[index + 1]] : []), [approvedChild]);
      else assert.deepEqual(JSON.parse(argv[argv.indexOf('--targets-json') + 1]), [resolvedTarget(approvedChild)]);
    }
  }
});

test('permission paths containing wildcard metacharacters never widen approval or launch', async () => {
  for (const repository of [repoPath('*'), repoPath('a?')]) {
    const current = await host();
    const answer = JSON.parse((await current.tools.memocap_remember.execute({ content: 'decision', repository }, current.context)).output);
    assert.equal(answer.status, 'failed');
    assert.equal(current.calls.length, 0);
    assert.equal(current.askCalls.length, 0);
  }
});

test('exact inventory readback accepts shadowed rows and follows pages until the committed ID', async () => {
  const current = await host({ inventory: (argv) => {
    const offset = Number(argv[argv.indexOf('--offset') + 1]);
    const entries = offset === 0 ? Array.from({ length: 20 }, (_, index) => memory(index + 2)) : [memory(1)];
    for (const entry of entries) entry.visibility = 'shadowed';
    return entries;
  } });
  const saved = JSON.parse((await current.tools.memocap_remember.execute({ content: 'shadowed rule', universal: true }, current.context)).output);
  assert.equal(saved.status, 'inserted');
  assert.equal(saved.readback.status, 'ok');
  const lists = current.calls.filter(({ argv }) => argv[0] === 'list');
  assert.deepEqual(lists.map(({ argv }) => argv[argv.indexOf('--offset') + 1]), ['0', '20']);
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'remember').length, 1);
});

test('readback failure remains a warning on a committed write without replay', async () => {
  const current = await host({ inventory: () => { throw Object.assign(new Error('inventory unavailable'), { code: 'cli_failed' }); } });
  const saved = JSON.parse((await current.tools.memocap_remember.execute({ content: 'persisted once' }, current.context)).output);
  assert.equal(saved.status, 'inserted');
  assert.equal(saved.readback.status, 'failed');
  assert.ok(saved.warnings.some((warning) => warning.code === 'readback_failed'));
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'remember').length, 1);
});

test('all tool and command CLI requests carry the current caller before positional content', async () => {
  const current = await host();
  const message = user('A', 'old-user-turn');
  await current.runtime.capture({ sessionID: 'A' }, { message: message.info, parts: message.parts });
  await current.tools.memocap_scope.execute({ paths: [repoPath('A')], query: 'release' }, current.context);
  await current.tools.memocap_remember.execute({ content: '--caller-json literal $(not executed)' }, current.context);
  for (const { argv } of current.calls) {
    const index = argv.indexOf('--caller-json');
    assert.ok(index >= 0, JSON.stringify(argv));
    assert.deepEqual(JSON.parse(argv[index + 1]), { actor: 'plugin', session_id: 'A', message_id: 'tool-msg' });
    if (argv.includes('--')) assert.ok(index < argv.indexOf('--'));
  }
  current.calls.length = 0;
  await current.commands.config({});
  const parts = [{ type: 'text', messageID: 'command-msg', text: 'placeholder' }];
  const output = { parts };
  await current.commands.execute({ command: 'memory', sessionID: 'A', arguments: 'recent' }, output);
  assert.equal(parts.length, 1);
  assert.equal(JSON.parse(parts[0].text).status, 'ok');
  const argv = current.calls[0].argv;
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--caller-json') + 1]),
    { actor: 'plugin', session_id: 'A', message_id: 'command-msg' });
});
