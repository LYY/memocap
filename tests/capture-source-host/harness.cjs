const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { lifecycleFixture, digest, write } = require('../setup-package-lifecycle-fixture.cjs');
const hostHelpers = require('../opencode-v1/host.cjs');
const repo = path.resolve(__dirname, '../..');

async function harness(evidence, version) {
  const fixture = lifecycleFixture(repo, evidence);
  let host;
  let provider;
  let api;
  const close = async () => {
    if (host) await host.close();
    if (provider) await provider.close();
    if (api) { api.closeAllConnections(); await new Promise((resolve) => api.close(resolve)); }
    evidence.cleanup.host_closed = evidence.host?.url ? await hostHelpers.portClosed(evidence.host.url) : true;
    evidence.cleanup.provider_closed = provider ? await hostHelpers.portClosed(provider.url) : true;
    evidence.cleanup.mock_closed = !api?.listening;
    evidence.cleanup.package = await fixture.cleanup();
  };
  try {
    const prepared = await fixture.prepare();
    const dependencies = path.resolve(prepared.runnerRoot, '../..');
    require.cache[require.resolve('../opencode-v1/host.cjs')].paths.unshift(dependencies);
    require.cache[require.resolve('../packaged-runtime.cjs')].paths.unshift(dependencies);
    provider = await hostHelpers.wireProvider();
    evidence.mock_requests = [];
    let submitted = false;
    api = http.createServer((request, response) => {
      evidence.mock_requests.push({ method: request.method, path: request.url });
      if (request.method === 'POST' && request.url === '/jobs') {
        submitted = true;
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'synthetic-job', state: 'queued' }));
      } else if (request.method === 'GET' && request.url === '/jobs/synthetic-job' && submitted) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'synthetic-job', state: 'completed', verified: true }));
      } else { response.writeHead(404); response.end('{}'); }
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const mockURL = `http://127.0.0.1:${api.address().port}`;
    const config = path.join(fixture.env.XDG_CONFIG_HOME, 'opencode/opencode.json');
    write(config, JSON.stringify({ share: 'disabled', plugin: [] }));
    const executable = version === '1.19.3' ? prepared.host : '/opt/homebrew/bin/opencode';
    assert.equal((await fixture.command(executable, ['--version'])).stdout.trim(), version);
    evidence.host = { version, sha256: digest(fs.readFileSync(executable)) };
    host = await hostHelpers.startHost({ env: fixture.env, config, host: executable,
      directories: { outside: fixture.project } }, provider, evidence);
    const sdkRoot = path.join(dependencies, '@opencode-ai/sdk');
    const sdk = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json')));
    assert.equal(sdk.version, '1.19.3');
    evidence.sdk = sdk.version;
    const { createOpencodeClient } = await import(pathToFileURL(path.join(sdkRoot, sdk.exports['.'].import)));
    const client = createOpencodeClient({ baseUrl: evidence.host.url, directory: fixture.project });
    const unwrap = (result) => { assert.equal(result.error, undefined); return result.data; };
    const session = unwrap(await client.session.create({ body: { title: 'Synthetic source framing',
      permission: [{ permission: 'bash', pattern: '*', action: 'allow' }] } }));
    const observe = async (name, step) => {
      provider.responses.push(...(Array.isArray(step) ? step : [step]), { text: 'Synthetic observation finished.' });
      const answer = unwrap(await client.session.prompt({ path: { id: session.id }, body: {
        model: { providerID: 'wire', modelID: 'wire-model' }, agent: 'build',
        parts: [{ type: 'text', text: `Observe synthetic source ${name}.` }],
      } }));
      // External QA inspection only; the pure production adapter has no SDK access.
      const history = unwrap(await client.session.messages({ path: { id: session.id } }));
      const messages = history.filter((message) => message.info.parentID === answer.info.parentID || message.info.id === answer.info.parentID);
      evidence.observations.push({ name, user_id: answer.info.parentID, observed_at: Date.now(), messages });
      return messages.flatMap((message) => message.parts).find((part) => part.type === 'tool');
    };
    return { fixture, provider, observe, mockURL, close };
  } catch (error) { await close(); throw error; }
}

module.exports = { harness };
