const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { lifecycleFixture } = require('./setup-package-lifecycle-fixture.cjs');
const { mergeHostConfig, write } = require('./packaged-runtime.cjs');
const { repo, wireProvider, startHost, portClosed } = require('./opencode-v1/host.cjs');
const { controlServer } = require('./opencode-capture-spike/control.cjs');

test('isolated real host extracts with all tools off and enforces native remember permission',
  { skip: process.env.MEMOCAP_CAPTURE_SPIKE !== '1', timeout: 240000 }, async (t) => {
    const evidence = { commands: [], assertions: [], cleanup: {}, paid_provider_requests: 0 };
    const fixture = lifecycleFixture(repo, evidence);
    let host;
    let provider;
    let control;
    try {
      const prepared = await fixture.prepare();
      const config = path.join(fixture.env.XDG_CONFIG_HOME, 'opencode/opencode.json');
      write(config, JSON.stringify({ plugin: [], share: 'disabled' }));
      const installed = JSON.parse((await fixture.command(process.execPath,
        [path.join(prepared.runnerRoot, 'scripts/setup.mjs'), 'install', '--global', '--yes', '--json'])).stdout);
      assert.equal(installed.exit_code, 0);
      const { createRequire } = require('node:module');
      const jsonc = createRequire(path.join(prepared.runnerRoot, 'package.json'))('jsonc-parser');
      const settings = jsonc.parse(fs.readFileSync(config, 'utf8'));
      control = await controlServer();
      mergeHostConfig(config, { plugin: [...settings.plugin,
        [pathToFileURL(path.join(__dirname, 'opencode-capture-spike/observer.mjs')).href,
          { control: control.url }]] });
      provider = await wireProvider();
      const executable = process.env.MEMOCAP_CAPTURE_HOST || prepared.host;
      evidence.actual_version = (await fixture.command(executable, ['--version'])).stdout.trim();
      host = await startHost({ env: fixture.env, config, host: executable,
        directories: { outside: fixture.project } }, provider, evidence);
      const sdkRoot = path.resolve(prepared.runnerRoot, '../../@opencode-ai/sdk');
      const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
      evidence.sdk = sdkPackage.version;
      const sdkPath = path.join(sdkRoot, sdkPackage.exports['.'].import);
      const { createOpencodeClient } = await import(pathToFileURL(sdkPath));
      const client = createOpencodeClient({ baseUrl: evidence.host.url, directory: fixture.project,
        fetch: (request) => fetch(request, { signal: AbortSignal.timeout(20000) }) });
      const unwrap = (result) => {
        assert.equal(result.error, undefined, JSON.stringify(result.error));
        return result.data;
      };
      const toolIDs = await host.api('/experimental/tool/ids');
      control.settings.tools = toolIDs;
      const toolsOff = Object.fromEntries(toolIDs.map((name) => [name, false]));
      assert.ok(toolIDs.includes('memocap_remember'));
      const model = { providerID: 'wire', modelID: 'wire-model' };
      const permission = [{ permission: '*', pattern: '*', action: 'deny' },
        { permission: 'memocap_remember', pattern: '*', action: 'allow' }];
      const parent = unwrap(await client.session.create({ body: { title: 'Capture spike parent', permission } }));
      provider.responses.push({ text: 'Verified synthetic route: use local fixture and check its result.' },
        { text: JSON.stringify({ content: 'Synthetic capture route: use local fixture and verify output.' }) });
      const reply = unwrap(await client.session.prompt({ path: { id: parent.id }, body: {
        model, tools: toolsOff, parts: [{ type: 'text', text: 'Finish the synthetic route task.' }],
      } }));
      const completed = await control.wait((event) => event.phase === 'worker.completed');
      const worker = control.events.find((event) => event.phase === 'worker.created');
      {
        assert.equal(reply.info.finish, 'stop');
        assert.equal(reply.info.parentID, worker.userID);
        assert.equal(worker.assistantID, reply.info.id);
        assert.equal(completed.finish, 'stop');
        assert.equal(completed.error, undefined);
        assert.deepEqual(JSON.parse(completed.text), {
          content: 'Synthetic capture route: use local fixture and verify output.',
        });
        await control.wait((event) => event.phase === 'worker.excluded');
        assert.equal(control.events.filter((event) => event.phase === 'worker.created').length, 1);
        assert.equal(provider.requests.length, 2);
        assert.deepEqual(provider.requests[1].body.tools || [], []);
        const child = unwrap(await client.session.get({ path: { id: worker.sessionID } }));
        assert.equal(child.parentID, parent.id);
        assert.deepEqual(child.permission, worker.permission);
        const currentParent = unwrap(await client.session.get({ path: { id: parent.id } }));
        assert.deepEqual(worker.permission, currentParent.permission);
      }
      let targetID;
      for (const action of ['allow', 'deny']) {
          const rules = [{ permission: '*', pattern: '*', action: 'deny' },
            { permission: 'memocap_remember', pattern: '*', action: 'allow' },
            ...(action === 'deny' ? [{ permission: 'memocap_remember', pattern: targetID, action: 'deny' }] : [])];
          const child = unwrap(await client.session.create({ body: { parentID: parent.id,
            title: `Capture write ${action}`, permission: rules } }));
          assert.deepEqual(child.permission, rules);
          const content = `capture-spike-${action}: synthetic local route with independent readback.`;
          const before = provider.requests.length;
          provider.responses.push({ tool: 'memocap_remember', args: { content, repository: fixture.project } },
            { text: 'Observed host tool result.' });
          const answer = unwrap(await client.session.prompt({ path: { id: child.id }, body: {
            model,
            parts: [{ type: 'text', text: 'Save the supplied synthetic candidate through the memory tool.' }],
          } }));
          assert.equal(answer.info.error, undefined);
          const messages = unwrap(await client.session.messages({ path: { id: child.id } }));
          const part = messages.flatMap((message) => message.parts)
            .find((entry) => entry.type === 'tool' && entry.tool === 'memocap_remember');
          assert.equal(part?.state.status, 'completed', JSON.stringify(part));
          const receipt = JSON.parse(part.state.output);
          evidence[action] = { receipt, model_requests: provider.requests.length - before };
          assert.equal(receipt.status, action === 'allow' ? 'inserted' : 'denied', JSON.stringify(receipt));
          if (action === 'allow') targetID = receipt.targets[0].repository_id;
          const readback = JSON.parse((await fixture.command('memocap',
            ['list', '--repo', fixture.project, '--json'])).stdout);
          const found = readback.results.map((entry) => entry.memory).find((memory) => memory.content === content);
          assert.equal(Boolean(found), action === 'allow');
          if (found) {
            assert.ok(receipt.returned_ids.includes(found.id));
            assert.equal(receipt.readback.status, 'ok');
            assert.ok(receipt.results.some((entry) => entry.memory.id === found.id &&
              entry.memory.content === content && entry.memory.placement === found.placement &&
              entry.memory.placement.startsWith('repository:')));
          }
          assert.equal(provider.requests.length - before, 2);
          evidence[action].independent_readback = Boolean(found);
      }
      assert.deepEqual(provider.errors, []);
      assert.equal(control.events.filter((event) => event.phase === 'failed').length, 0,
        JSON.stringify(control.events));
      evidence.events = control.events;
      evidence.tools_off = provider.requests[1].body.tools || [];
      evidence.status = 'passed';
    } catch (error) {
      evidence.status = 'failed';
      evidence.error = error.stack;
      throw error;
    } finally {
      if (host) await host.close();
      if (evidence.host?.url) evidence.cleanup.host_port_closed = await portClosed(evidence.host.url);
      if (provider) {
        evidence.request_count = provider.requests.length;
        await provider.close();
        evidence.cleanup.provider_port_closed = await portClosed(provider.url);
      }
      if (control) await control.close();
      evidence.cleanup.package = await fixture.cleanup();
      const output = process.env.MEMOCAP_CAPTURE_EVIDENCE;
      if (output) fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
      t.diagnostic(JSON.stringify({ status: evidence.status, version: evidence.actual_version,
        request_count: evidence.request_count, paid_provider_requests: 0, cleanup: evidence.cleanup,
        error: evidence.error }));
    }
  });
