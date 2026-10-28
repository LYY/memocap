const assert = require('node:assert/strict');
const test = require('node:test');
const { sandbox, fixture, user } = require('./plugin-fixture.cjs');

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
  assert.equal(writes[0][writes[0].indexOf('--repo') + 1], fixturePackage.B);
  assert.equal(writes[0][writes[0].indexOf('--') + 1], content);
  const compact = { context: [] };
  await hooks['experimental.session.compacting']({ sessionID: 'A' }, compact);
  assert.equal(compact.context.length, 1);
  await hooks.dispose();
});
