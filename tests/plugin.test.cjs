const assert = require('node:assert/strict');
const test = require('node:test');
const { sandbox, fixture, user } = require('./plugin-fixture.cjs');

test('real bridge retains targets and anchored database after deleting every checkout and original cwd', async (context) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const current = await sandbox();
  context.after(current.cleanup);
  const previousCwd = process.cwd();
  context.mock.property(process, 'env', { ...process.env, MEMOCAP_DB: '../anchored.db' });
  const host = fixture();
  host.input.client.session.get = async () => ({ data: { directory: current.A } });
  let hooks;
  try {
    process.chdir(current.A);
    hooks = await current.module.default.server(host.input);
  } finally { process.chdir(previousCwd); }
  context.after(() => hooks.dispose());
  const toolContext = { sessionID: 'A', messageID: 'deletion', abort: new AbortController().signal,
    ask: async () => {}, metadata() {} };
  const scoped = JSON.parse((await hooks.tool.memocap_scope.execute({ paths: [current.B] }, toolContext)).output);
  assert.equal(scoped.status, 'ok');
  fs.rmSync(current.A, { recursive: true });
  fs.rmSync(current.B, { recursive: true });
  const saved = JSON.parse((await hooks.tool.memocap_remember.execute({ content: 'survives deleted cwd' }, toolContext)).output);
  assert.equal(saved.status, 'inserted');
  assert.equal(saved.readback.status, 'ok');
  assert.equal(saved.targets[0].repository_id, scoped.targets[0].repository_id);
  const recalled = JSON.parse((await hooks.tool.memocap_recall.execute({ query: 'survives' }, toolContext)).output);
  assert.equal(recalled.status, 'ok');
  const missing = JSON.parse((await hooks.tool.memocap_scope.execute({ paths: [current.B] }, toolContext)).output);
  assert.equal(missing.status, 'failed');
  for (const execution of current.executions()) {
    assert.equal(execution.database, path.join(fs.realpathSync(current.root), 'anchored.db'));
    assert.equal(fs.realpathSync(execution.cwd), fs.realpathSync(path.parse(previousCwd).root));
  }
});

test('V1 exported server executes hooks through the real bridge and fixture child, with literal single-target write', async (context) => {
  const fixturePackage = await sandbox();
  context.after(fixturePackage.cleanup);
  assert.equal(fixturePackage.module.default.id, 'memocap');
  const host = fixture();
  host.input.client.session.get = async () => ({ data: { directory: fixturePackage.A } });
  const hooks = await fixturePackage.module.default.server(host.input);
  const config = {};
  await hooks.config(config);
  assert.deepEqual(Object.keys(hooks.tool).sort(), ['memocap_organize', 'memocap_recall', 'memocap_remember', 'memocap_scope']);
  const message = user();
  await hooks['chat.message']({ sessionID: 'A' }, { message: message.info, parts: message.parts });
  await hooks['experimental.chat.messages.transform']({}, { messages: [message] });
  assert.equal(message.parts.at(-1).metadata.memocap.injection_status, 'prepared');
  assert.deepEqual(message.parts.at(-1).metadata.memocap.injected_ids, [91]);
  const output = { parts: [] };
  await hooks['command.execute.before']({ command: 'memory', sessionID: 'A', arguments: `scope "${fixturePackage.B}"` }, output);
  assert.equal(JSON.parse(output.parts[0].text).status, 'ok');
  let permissions = 0;
  const toolContext = { sessionID: 'A', messageID: 'msg-1', directory: fixturePackage.A, worktree: fixturePackage.A,
    abort: new AbortController().signal, ask: async () => { permissions++; }, metadata() {} };
  const content = 'literal "quote" $(touch should-not-exist)\nline';
  const saved = JSON.parse((await hooks.tool.memocap_remember.execute({ content }, toolContext)).output);
  assert.equal(saved.status, 'inserted');
  assert.equal(saved.readback.status, 'ok');
  assert.equal(permissions, 1);
  const writes = fixturePackage.calls().filter((argv) => argv[0] === 'remember');
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0][writes[0].indexOf('--targets-json') + 1])[0].canonical_path, fixturePackage.B);
  assert.equal(writes[0][writes[0].indexOf('--') + 1], content);
  const compact = { context: [] };
  await hooks['experimental.session.compacting']({ sessionID: 'A' }, compact);
  assert.equal(compact.context.length, 1);
  await hooks.dispose();
});
