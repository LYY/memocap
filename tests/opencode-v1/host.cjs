const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');

const repo = path.resolve(__dirname, '../..');
const officialVersion = '1.19.3';

function execute(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 20000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(binary)} ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

function isolated(root) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'),
    LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'appdata'),
    MEMOCAP_HOME: path.join(root, 'home'), MEMOCAP_DB: path.join(root, 'memory', 'core.db'),
    MEMOCAP_DATA_DIR: path.join(root, 'memory'), CI: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
    OPENCODE_CONFIG_DIR: path.join(root, 'config', 'opencode'),
  });
  for (const directory of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.LOCALAPPDATA, env.APPDATA,
    env.MEMOCAP_DATA_DIR, env.OPENCODE_CONFIG_DIR]) fs.mkdirSync(directory, { recursive: true });
  return env;
}

function prepare(root, evidence) {
  const env = isolated(root);
  const host = process.env.MEMOCAP_TEST_OPENCODE || 'opencode';
  evidence.host = { binary: host, version: execute(host, ['--version'], { env }) };
  assert.equal(evidence.host.version, officialVersion, 'integration requires exact official OpenCode 1.19.3');
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).version;
  const native = path.resolve(process.env.MEMOCAP_TEST_NATIVE || path.join(repo, 'target/debug',
    process.platform === 'win32' ? 'memocap.exe' : 'memocap'));
  const nativeVersion = execute(native, ['--version'], { env });
  evidence.native = { version: nativeVersion, package_version: version,
    origin: 'prepublish_local_build_not_published_release_asset' };
  assert.equal(nativeVersion, `memocap ${version}`, 'rebuild native binary after package version changes');
  const assets = { 'darwin-arm64': 'memocap-aarch64-apple-darwin',
    'linux-x64': 'memocap-x86_64-unknown-linux-gnu', 'win32-x64': 'memocap-x86_64-pc-windows-msvc.exe' };
  const asset = assets[`${process.platform}-${process.arch}`];
  assert.ok(asset, 'unsupported release platform');
  const base = process.platform === 'darwin' ? path.join(env.HOME, 'Library/Caches') :
    process.platform === 'win32' ? env.LOCALAPPDATA : env.XDG_CACHE_HOME;
  const cache = path.join(base, 'memocap', version);
  fs.mkdirSync(cache, { recursive: true });
  const cached = path.join(cache, asset);
  fs.copyFileSync(native, cached);
  fs.chmodSync(cached, 0o755);
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(cached)).digest('hex');
  fs.writeFileSync(`${cached}.sha256`, `${checksum}  ${asset}\n`);
  evidence.native.sha256 = checksum;
  evidence.native.launcher_version = execute(process.execPath, [path.join(repo, 'bin/cli.cjs'), '--version'], { env });
  assert.equal(evidence.native.launcher_version, nativeVersion);
  evidence.native.official_host_launcher_probe = execute(host, [path.join(repo, 'bin/cli.cjs'), '--version'], { env });
  evidence.sdk = Object.fromEntries(['plugin', 'sdk'].map((name) => {
    const installed = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/@opencode-ai', name, 'package.json'))).version;
    assert.equal(installed, officialVersion);
    return [name, installed];
  }));
  const directories = Object.fromEntries(['outside', 'A', 'B'].map((name) => [name, path.join(root, name)]));
  for (const directory of Object.values(directories)) fs.mkdirSync(directory);
  const cli = (args) => JSON.parse(execute(native, ['--json', ...args], { env, cwd: directories.outside }));
  return { env, host, native, version, directories, cli };
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

async function startHost(fixture, provider, evidence, plugin = path.join(repo, 'plugin/index.js')) {
  const config = {
    plugin: [pathToFileURL(plugin).href], model: 'wire/wire-model', small_model: 'wire/wire-model',
    enabled_providers: ['wire'], share: 'disabled', autoupdate: false,
    permission: { '*': 'deny', memocap_scope: 'allow', memocap_recall: 'allow', memocap_remember: 'allow' },
    provider: { wire: { npm: '@ai-sdk/openai-compatible', name: 'Local deterministic wire fixture',
      options: { baseURL: provider.url, apiKey: 'local-fixture-only', timeout: 10000 },
      models: { 'wire-model': { name: 'Local fixture', tool_call: true,
        limit: { context: 64000, output: 1024 }, cost: { input: 0, output: 0 } } } } },
  };
  const configFile = path.join(fixture.env.OPENCODE_CONFIG_DIR, 'opencode.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const env = { ...fixture.env, OPENCODE_CONFIG: configFile };
  const reservation = require('node:net').createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(fixture.host, ['serve', '--hostname=127.0.0.1', `--port=${port}`, '--print-logs'], {
    env, cwd: fixture.directories.outside, stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    const exited = once(child, 'exit');
    child.kill();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
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
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    const [code, signal] = await exited;
    clearTimeout(timer);
    evidence.host.exit = { code, signal };
    evidence.host.log_tail = output.slice(-12000);
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
