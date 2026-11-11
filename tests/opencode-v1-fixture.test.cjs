const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startHost, wireProvider } = require('./opencode-v1/host.cjs');
const { isolatedEnvironment } = require('./packaged-runtime.cjs');

for (const grants of [undefined, {
  memocap_recall: { library: 'allow', 'repository:unapproved': 'deny' },
  memocap_read: { library: 'allow', 'repository:unapproved': 'deny' },
}]) {
  test(`host permission fixture ${grants ? 'preserves installed exact library grants' : 'does not fabricate missing library grants'}`,
    async (context) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memocap-host-grants-'));
      context.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const config = path.join(root, 'opencode.json');
      const plugin = [['@lyy-gh/memocap', { skillDirectory: path.join(root, 'policy') }]];
      fs.writeFileSync(config, JSON.stringify({ plugin, permission: grants ?? {} }));
      const fixture = { config, host: path.join(root, 'absent-host'),
        env: isolatedEnvironment(root), directories: { outside: root } };

      await assert.rejects(startHost(fixture, { url: 'http://127.0.0.1:1/v1' }, {}), { code: 'ENOENT' });

      const configured = JSON.parse(fs.readFileSync(config, 'utf8'));
      assert.deepEqual(configured.plugin, plugin);
      assert.equal(configured.permission['*'], 'deny');
      for (const tool of ['memocap_recall', 'memocap_read']) {
        assert.deepEqual(configured.permission[tool], grants?.[tool]);
      }
    });
}

for (const enabled of [false, true]) {
  test(`wire provider capture extraction opt-in ${enabled} preserves the appropriate response queue`, async () => {
    const provider = await wireProvider({ emptyCaptureExtraction: enabled });
    try {
      provider.responses.push({ text: 'durable capture fixture candidate' }, { text: 'normal task result' });
      const invoke = async (content) => {
        const result = await fetch(`${provider.url}/chat/completions`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(2000),
          body: JSON.stringify({ model: 'wire-model', messages: [{ role: 'user', content }] }) });
        assert.equal(result.status, 200);
        return (await result.text()).split('\n').filter((line) => line.startsWith('data: {'))
          .map((line) => JSON.parse(line.slice(6)))[0].choices[0].delta.content;
      };
      const extracted = await invoke(JSON.stringify({ evidence: [{ sourceId: 'fixture:1', text: 'transient task' }] }));
      assert.equal(extracted, enabled ? '{"candidates":[]}' : 'durable capture fixture candidate');
      assert.equal(provider.responses.length, enabled ? 2 : 1);
      assert.equal(await invoke('ordinary task mentions evidence without a JSON packet'),
        enabled ? 'durable capture fixture candidate' : 'normal task result');
      assert.deepEqual(provider.errors, []);
    } finally { await provider.close(); }
  });
}
