const assert = require('node:assert/strict');
const test = require('node:test');
const { sandbox, fixture } = require('./plugin-fixture.cjs');

test('organization post-tool hook restores complete JSON after host truncation without changing other tools', async (context) => {
  const current = await sandbox();
  context.after(() => current.cleanup());
  const hooks = await current.module.default.server(fixture().input);
  context.after(() => hooks.dispose());
  const { createTools } = await import('../plugin/tools.js');
  const payload = { status: 'ok', untrusted_data: { trust: 'untrusted_reference', receipt: {
    organization: { records: [{ content: '完整快照'.repeat(20000) }] } } } };
  const tools = createTools({ organization: { permitted: async () => payload } });
  const rendered = await tools.memocap_organize.execute({ operation: 'page', request: '{}' }, {});
  const output = { ...rendered, output: 'host truncated JSON',
    metadata: { ...rendered.metadata, truncated: true, outputPath: '/host/truncated' } };
  await hooks['tool.execute.after']({ tool: 'memocap_organize' }, output);
  assert.deepEqual(JSON.parse(output.output), payload);
  assert.equal(output.metadata.truncated, false);
  assert.equal(output.metadata.outputPath, undefined);
  const ordinary = { title: 'ordinary', output: 'unchanged', metadata: { truncated: true } };
  await hooks['tool.execute.after']({ tool: 'memocap_recall' }, ordinary);
  assert.deepEqual(ordinary, { title: 'ordinary', output: 'unchanged', metadata: { truncated: true } });
});
