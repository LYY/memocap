const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { lifecycleFixture } = require('../setup-package-lifecycle-fixture.cjs');
const { runLifecycle } = require('../setup-package-lifecycle.cjs');
const { mergeHostConfig } = require('../packaged-runtime.cjs');

const repo = path.resolve(__dirname, '../..');
const officialVersion = '1.19.3';

function execute(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 20000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(binary)} ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

async function prepare(root, evidence) {
  const packaged = lifecycleFixture(repo, evidence);
  try {
    const prepared = await packaged.prepare();
    const installed = await runLifecycle(packaged, prepared, evidence);
    const { env, host, version } = packaged;
    const native = path.resolve(process.env.MEMOCAP_TEST_NATIVE || path.join(repo, 'target/debug',
      process.platform === 'win32' ? 'memocap.exe' : 'memocap'));
    const cache = path.join(env.XDG_CACHE_HOME, 'opencode/packages', `@lyy-gh/memocap@${version}`);
    await packaged.command('npm', ['install', '--prefix', cache, '--ignore-scripts', prepared.tarball]);
    const pluginRoot = path.join(cache, 'node_modules/@lyy-gh/memocap');
    assert.equal(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'))).version, version);
    const { inspectPolicy } = await import(pathToFileURL(path.join(pluginRoot, 'lib/policy.mjs')));
    assert.equal(inspectPolicy(path.join(pluginRoot, 'skills/memocap')).digest, installed.bundled.digest);
    evidence.plugin_package = { version, cache: 'actual_tarball_installed_at_official_exact_spec_cache',
      sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(pluginRoot, 'plugin/index.js'))).digest('hex') };
    evidence.sdk = Object.fromEntries(['plugin', 'sdk'].map((name) => {
      const installedVersion = JSON.parse(fs.readFileSync(path.join(cache, 'node_modules/@opencode-ai', name, 'package.json'))).version;
      assert.equal(installedVersion, officialVersion);
      return [name, installedVersion];
    }));
    const directories = { outside: path.join(root, 'outside'), A: path.join(root, 'A'), B: path.join(root, 'B') };
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    const cli = (args) => JSON.parse(execute(native, ['--json', ...args], { env, cwd: directories.outside }));
    return { env, host, native, version, directories, cli, ...installed, packaged,
      async cleanup() { return packaged.cleanup(); } };
  } catch (error) { evidence.cleanup.package = await packaged.cleanup(); throw error; }
}

async function wireProvider() {
  const requests = [];
  const responses = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(body.model, 'wire-model');
      requests.push({ method: request.method, url: request.url, body });
      const step = responses.shift() || { text: 'Local wire fixture completed.' };
      const delta = step.tool ? { role: 'assistant', tool_calls: [{ index: 0,
        id: `call_${requests.length}`, type: 'function', function: {
          name: step.tool, arguments: JSON.stringify(step.args),
        } }] } : { role: 'assistant', content: step.text };
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const event = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      const common = { id: `chatcmpl_${requests.length}`, object: 'chat.completion.chunk',
        created: 1700000000, model: 'wire-model' };
      event({ ...common, choices: [{ index: 0, delta, finish_reason: null }] });
      event({ ...common, choices: [{ index: 0, delta: {}, finish_reason: step.tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
      response.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(error.message);
      response.writeHead(500);
      response.end('invalid local fixture request');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, responses, errors, url: `http://127.0.0.1:${server.address().port}/v1`,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

async function startHost(fixture, provider, evidence) {
  const config = {
    model: 'wire/wire-model', small_model: 'wire/wire-model',
    enabled_providers: ['wire'], share: 'disabled', autoupdate: false,
    permission: { '*': 'deny', skill: 'allow', read: 'allow', external_directory: 'allow',
      memocap_scope: 'allow', memocap_recall: 'allow', memocap_remember: 'allow' },
    provider: { wire: { npm: '@ai-sdk/openai-compatible', name: 'Local deterministic wire fixture',
      options: { baseURL: provider.url, apiKey: 'local-fixture-only', timeout: 10000 },
      models: { 'wire-model': { name: 'Local fixture', tool_call: true,
        limit: { context: 64000, output: 1024 }, cost: { input: 0, output: 0 } } } } },
  };
  const configFile = fixture.config;
  mergeHostConfig(configFile, config);
  const env = fixture.env;
  const reservation = require('node:net').createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(fixture.host, ['serve', '--hostname=127.0.0.1', `--port=${port}`, '--print-logs'], {
    env, cwd: fixture.directories.outside, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completed = new Promise((resolve) => child.once('close', (code, signal) => resolve([code, signal])));
  async function stop() {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { return await completed; }
    finally { clearTimeout(timer); }
  }
  let output = '';
  let url;
  try {
    url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`host readiness timed out: ${output.slice(-6000)}`)), 20000);
      const failed = (error) => { clearTimeout(timer); reject(error); };
      child.once('error', failed);
      child.once('exit', (code, signal) => failed(new Error(`host exited before ready: ${code}/${signal}: ${output}`)));
      const received = (chunk) => {
        output = (output + chunk.toString()).slice(-50000);
        const match = /opencode server listening on (http:\/\/[^\s]+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stdout.on('data', received);
      child.stderr.on('data', received);
    });
  } catch (error) {
    await stop();
    throw error;
  }
  evidence.host.pid = child.pid;
  evidence.host.url = url;
  assert.equal(new URL(url).port, String(port), 'host must bind the isolated ephemeral port');
  async function api(route, body) {
    const response = await fetch(`${url}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': fixture.directories.outside },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000) });
    const raw = await response.text();
    assert.ok(response.ok, `${route}: ${response.status}: ${raw.slice(0, 1000)}`);
    return raw ? JSON.parse(raw) : null;
  }
  return { api, async close() {
    try { await api('/instance/dispose', {}); } catch (error) { evidence.cleanup.dispose_error = error.message; }
    const [code, signal] = await stop();
    evidence.host.exit = { code, signal };
    evidence.host.log_tail = output.slice(-2000);
  } };
}

async function portClosed(url) {
  const address = new URL(url);
  return new Promise((resolve) => {
    const socket = require('node:net').connect({ host: address.hostname, port: Number(address.port) });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error) => resolve(error.code === 'ECONNREFUSED'));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

module.exports = { repo, officialVersion, prepare, wireProvider, startHost, portClosed };
