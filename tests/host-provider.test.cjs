const assert = require('node:assert/strict');
const test = require('node:test');
const { wireProvider } = require('./opencode-v1/host.cjs');

test('local provider fixture preserves UTF8 request bodies across HTTP chunk boundaries', async (context) => {
  const provider = await wireProvider();
  context.after(() => provider.close());
  const content = '完整详情'.repeat(100000);
  for (const prefix of ['', 'a', 'aa']) {
    const body = { model: 'wire-model', messages: [{ role: 'user', content: prefix + content }] };
    const response = await fetch(`${provider.url}/chat/completions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await response.text();
    assert.equal(response.status, 200);
    const observed = provider.requests.at(-1).body.messages[0].content;
    assert.equal(Buffer.byteLength(observed), Buffer.byteLength(body.messages[0].content));
    assert.ok(observed === body.messages[0].content, 'the provider receives exact request bytes');
  }
});
