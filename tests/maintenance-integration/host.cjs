const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { isolatedEnvironment, write, digest } = require('../packaged-runtime.cjs');
const { wireProvider, startHost, portClosed } = require('../opencode-v1/host.cjs');
const { controlServer } = require('../opencode-capture-spike/control.cjs');
const { isSupportedHost } = require('../../lib/opencode-host.js');
const repo = path.resolve(__dirname, '../..');
const temp = '/var/folders/x_/n5qr2_211jg2j9_7q_gdxw940000gn/T/opencode';

function userPacket(provider) {
  const content = provider.requests.at(-1).body.messages.findLast((message) => message.role === 'user').content;
  return JSON.parse(typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join(''));
}
function captureDone(control, session) {
  return control.wait((event) => event.phase === 'native.finished' && event.args[0] === 'activity' &&
    event.args[1] === 'record' && JSON.parse(event.args[event.args.indexOf('--payload') + 1]).detail.phase === 'capture_review' &&
    JSON.parse(event.args[event.args.indexOf('--payload') + 1]).context.session_id === session.id);
}
async function maintenanceHost(version, evidence, options = {}) {
  const { selectedHost } = options;
  const { MEMOCAP_MAINTENANCE_HOST_EXECUTABLE: explicitHost, MEMOCAP_MAINTENANCE_HOST_EXPECTED_VERSION: explicitVersion } = process.env;
  if (explicitHost !== undefined || explicitVersion !== undefined) {
    assert.ok(explicitHost && explicitVersion, 'MEMOCAP_MAINTENANCE_HOST_EXECUTABLE and MEMOCAP_MAINTENANCE_HOST_EXPECTED_VERSION must be set together');
    assert.ok(path.isAbsolute(explicitHost), 'explicit host executable must be an absolute path');
    assert.ok(isSupportedHost(explicitVersion), 'expected host version must be an exact OpenCode v1 version');
    assert.equal(explicitVersion, version, 'expected host version must match the scenario version');
  }
  const explicitBinary = explicitHost ? fs.realpathSync(explicitHost) : undefined;
  if (selectedHost) {
    assert.ok(isSupportedHost(selectedHost.version), 'capture host must be an exact OpenCode v1 version');
    assert.equal(selectedHost.version, version, 'capture host version must match the scenario version');
    assert.ok(path.isAbsolute(selectedHost.executable), 'capture host executable must be an absolute path');
    if (explicitBinary) assert.equal(explicitBinary, selectedHost.executable, 'explicit maintenance host conflicts with the capture host');
    assert.equal(fs.realpathSync(selectedHost.executable), selectedHost.executable, 'capture host path changed');
    assert.equal(digest(fs.readFileSync(selectedHost.executable)), selectedHost.sha256, 'capture host bytes changed');
  }
  const binary = selectedHost?.executable ?? explicitBinary ??
    (version === '1.19.5' ? '/opt/homebrew/bin/opencode' : process.env.MEMOCAP_MAINTENANCE_HOST_1193);
  assert.ok(binary, 'MEMOCAP_MAINTENANCE_HOST_1193 must name an existing official host; no install');
  const files = ['package.json', 'plugin/cli.js', 'plugin/operations.js', 'plugin/tools.js',
    ...fs.readdirSync(path.join(repo, 'plugin/maintenance')).map((name) => `plugin/maintenance/${name}`),
    ...fs.readdirSync(path.join(repo, 'plugin/capture'), { recursive: true }).filter((name) => name.endsWith('.js')).map((name) => `plugin/capture/${name}`),
    ...fs.readdirSync(__dirname).map((name) => `tests/maintenance-integration/${name}`),
    'tests/maintenance-host.integration.test.cjs', 'tests/maintenance-host-adversarial.integration.test.cjs', 'tests/maintenance-host-evidence.integration.test.cjs', 'tests/maintenance-host-lifecycle.integration.test.cjs'];
  evidence.source_sha256 = Object.fromEntries(files.map((file) => [file, digest(fs.readFileSync(path.join(repo, file)))]));
  const root = fs.mkdtempSync(path.join(temp, 'maintenance-host-'));
  const env = isolatedEnvironment(root);
  env.PATH = `${path.dirname(process.execPath)}:${env.PATH}`;
  try {
    const actual = spawnSync(binary, ['--version'], { env, encoding: 'utf8', timeout: 10000 });
    if (actual.error) throw actual.error;
    assert.equal(actual.status, 0, actual.stderr);
    const observedVersion = actual.stdout.trim();
    assert.equal(observedVersion, version);
    const sha256 = digest(fs.readFileSync(binary));
    if (selectedHost) assert.equal(sha256, selectedHost.sha256, 'capture host bytes changed');
    evidence.host = { version: observedVersion, sha256 };
    if (selectedHost || explicitBinary) evidence.host.executable = binary;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    evidence.cleanup.sandbox_removed = !fs.existsSync(root);
    throw error;
  }
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const native = path.join(repo, 'target/debug/memocap');
  const cli = (args, input) => {
    const result = spawnSync(native, ['--json', ...args], { env, cwd: project, encoding: 'utf8', timeout: 10000,
      input: input === undefined ? undefined : JSON.stringify(input) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  cli(['remember', '--universal', '--force', '--', 'For local fixture, route is /v1 and unique timeout is 7.']);
  const control = await controlServer();
  const provider = await wireProvider();
  const database = fs.realpathSync(env.MEMOCAP_DB);
  const pattern = `v1/db:${Buffer.from(database).toString('base64url')}/placement:dW5pdmVyc2Fs/op:update/id:1`;
  control.settings.permission = options.permission?.(pattern) ?? { [pattern]: 'allow' };
  control.settings.nativeMode = options.nativeMode;
  control.settings.agentPrompt = options.agentPrompt;
  control.settings.childSecret = options.childSecret;
  const config = path.join(env.XDG_CONFIG_HOME, 'opencode/opencode.json');
  write(config, JSON.stringify({ plugin: [[pathToFileURL(path.join(__dirname, 'observer.mjs')).href,
    { control: control.url, plugin: pathToFileURL(path.join(repo, 'plugin/cli.js')).href }]] }));
  env.MAINTENANCE_PROBE_SETTINGS = path.join(root, 'probe.json');
  write(env.MAINTENANCE_PROBE_SETTINGS, JSON.stringify({ native, control: control.url }));
  env.MEMOCAP_BINARY = path.join(root, 'memocap-probe');
  write(env.MEMOCAP_BINARY, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(__dirname, 'native-probe.cjs'))});\n`);
  fs.chmodSync(env.MEMOCAP_BINARY, 0o755);
  evidence.native = { sha256: digest(fs.readFileSync(native)), version: cli(['status']).package_version };
  let host;
  const close = async () => {
    control.releaseAll();
    if (host) await host.close();
    await provider.close(); await control.close();
    evidence.cleanup.host_port_closed = evidence.host.url ? await portClosed(evidence.host.url) : true;
    evidence.cleanup.provider_port_closed = await portClosed(provider.url);
    evidence.cleanup.control_port_closed = await portClosed(control.url);
    fs.rmSync(root, { recursive: true, force: true });
    evidence.cleanup.sandbox_removed = !fs.existsSync(root);
  };
  try {
    host = await startHost({ env, config, host: binary, directories: { outside: project } }, provider, evidence);
    const { createOpencodeClient } = await import('@opencode-ai/sdk');
    const client = createOpencodeClient({ baseUrl: evidence.host.url, directory: project });
    const unwrap = (value) => { assert.equal(value.error, undefined, JSON.stringify(value.error)); return value.data; };
    const model = { providerID: 'wire', modelID: 'wire-model' };
    const parent = (action = 'allow') => client.session.create({ body: { title: 'Maintenance native integration', permission: [
      { permission: 'memocap_maintain', pattern: '*', action },
    ] } }).then(unwrap);
    const prompt = (session, text) => client.session.prompt({ path: { id: session.id }, body: {
      model, agent: 'build', parts: [{ type: 'text', text }],
    } }).then(unwrap);
    const sql = (statement) => {
      const result = spawnSync('/usr/bin/sqlite3', [database, statement], { env, encoding: 'utf8', timeout: 3000 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    return { root, env, database, pattern, cli, sql, control, provider, host, client, unwrap, parent, prompt,
      captureDone: (session) => captureDone(control, session), close };
  } catch (error) { await close(); throw error; }
}
module.exports = { maintenanceHost, userPacket, captureDone };
