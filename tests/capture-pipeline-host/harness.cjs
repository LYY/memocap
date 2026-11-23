const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { lifecycleFixture, digest, write } = require('../setup-package-lifecycle-fixture.cjs');
const { wireProvider, startHost, portClosed } = require('../opencode-v1/host.cjs');
const { controlServer } = require('../opencode-capture-spike/control.cjs');
const { packageSource } = require('../capture-expansion-spike/package-source.cjs');
const { userText } = require('../capture-expansion-spike/harness.cjs');
const { isSupportedHost } = require('../../lib/opencode-host.js');
const repo = path.resolve(__dirname, '../..');

async function harness(evidence, scratch) {
  const packagedFlag = process.env.MEMOCAP_CAPTURE_PACKAGED_HOST;
  const packaged = packagedFlag === '1';
  const { MEMOCAP_CAPTURE_HOST_EXECUTABLE: explicitHost, MEMOCAP_CAPTURE_HOST_EXPECTED_VERSION: explicitVersion } = process.env;
  if (explicitHost !== undefined || explicitVersion !== undefined) {
    assert.ok(explicitHost && explicitVersion, 'MEMOCAP_CAPTURE_HOST_EXECUTABLE and MEMOCAP_CAPTURE_HOST_EXPECTED_VERSION must be set together');
    assert.ok(packagedFlag === undefined || packagedFlag === '0', 'explicit host selection requires MEMOCAP_CAPTURE_PACKAGED_HOST to be unset or 0');
    assert.ok(path.isAbsolute(explicitHost), 'explicit host executable must be an absolute path');
    assert.ok(isSupportedHost(explicitVersion), 'expected host version must be an exact OpenCode v1 version');
  }
  const fixture = lifecycleFixture(repo, evidence);
  fixture.env.npm_config_offline = 'true';
  let host;
  let provider;
  let control;
  const scratchRoot = path.join(scratch, 'package');
  const close = async () => {
    control?.releaseAll();
    if (host) await host.close();
    if (provider) await provider.close();
    if (control) await control.close();
    if (control) write(path.join(scratch, 'telemetry.json'), JSON.stringify({ events: control.events, provider_requests: provider.requests }, null, 2));
    evidence.cleanup.host_port_closed = evidence.host?.url ? await portClosed(evidence.host.url) : true;
    evidence.cleanup.provider_port_closed = provider ? await portClosed(provider.url) : true;
    evidence.cleanup.control_port_closed = control ? await portClosed(control.url) : true;
    evidence.cleanup.package = await fixture.cleanup();
    fs.rmSync(path.join(scratchRoot, 'node_modules'), { force: true });
    evidence.cleanup.scratch_dependency_link_removed = true;
  };
  try {
    const prepared = await fixture.prepare({ installPackagedHost: !explicitHost });
    packageSource(prepared, scratchRoot, evidence);
    evidence.package_root = scratchRoot;
    const dependencies = path.resolve(prepared.runnerRoot, '../..');
    fs.symlinkSync(dependencies, path.join(scratchRoot, 'node_modules'));
    require.cache[require.resolve('../opencode-v1/host.cjs')].paths.unshift(dependencies);
    require.cache[require.resolve('../packaged-runtime.cjs')].paths.unshift(dependencies);
    control = await controlServer();
    provider = await wireProvider();
    const config = path.join(fixture.env.XDG_CONFIG_HOME, 'opencode/opencode.json');
    const marker = path.join(fixture.root, 'native-handshake-marker');
    const probeOptions = path.join(fixture.root, 'native-probe.json');
    write(probeOptions, JSON.stringify({ control: control.url, marker, native: path.join(repo, 'target/debug/memocap') }));
    const cached = path.join(fixture.home, 'Library/Caches/memocap', fixture.version, 'memocap-aarch64-apple-darwin');
    write(cached, `#!${process.execPath}\nprocess.argv.splice(2,0,${JSON.stringify(probeOptions)});require(${JSON.stringify(path.resolve(__dirname, '../opencode-capture/native-probe.cjs'))});\n`);
    fs.chmodSync(cached, 0o755);
    write(`${cached}.sha256`, `${digest(fs.readFileSync(cached))}  ${path.basename(cached)}\n`);
    write(config, JSON.stringify({ share: 'disabled', plugin: [[pathToFileURL(path.join(__dirname, 'observer.mjs')).href,
      { control: control.url, marker, plugin: pathToFileURL(path.join(scratchRoot, 'plugin/cli.js')).href, captureOnly: evidence.entry === 'capture_only' }]] }));
    const executable = explicitHost ? fs.realpathSync(explicitHost) : packaged ? prepared.host : '/opt/homebrew/bin/opencode';
    const selectedHash = explicitHost ? digest(fs.readFileSync(executable)) : undefined;
    const version = (await fixture.command(executable, ['--version'])).stdout.trim();
    assert.equal(version, explicitVersion ?? (packaged ? '1.19.3' : '1.19.5'), 'selected host must report the exact fixture version');
    const sha256 = digest(fs.readFileSync(executable));
    if (explicitHost) {
      assert.equal(fs.realpathSync(explicitHost), executable, 'selected host path changed');
      assert.equal(sha256, selectedHash, 'selected host bytes changed');
    }
    evidence.host = { version, sha256, origin: explicitHost ? 'explicit_selected_host' :
      packaged ? 'official_npm_platform_dependency' : 'existing_local_host' };
    if (explicitHost) evidence.host.executable = executable;
    host = await startHost({ env: fixture.env, config, host: executable, directories: { outside: fixture.project } }, provider, evidence);
    const sdkRoot = path.join(dependencies, '@opencode-ai/sdk');
    const sdk = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json')));
    evidence.sdk = { version: sdk.version, package_sha256: digest(fs.readFileSync(path.join(sdkRoot, 'package.json'))) };
    const { createOpencodeClient } = await import(pathToFileURL(path.join(sdkRoot, sdk.exports['.'].import)));
    const client = createOpencodeClient({ baseUrl: evidence.host.url, directory: fixture.project });
    const unwrap = (result) => { assert.equal(result.error, undefined, JSON.stringify(result.error)); return result.data; };
    const model = { providerID: 'wire', modelID: 'wire-model' };
    const cli = async (args) => JSON.parse((await fixture.command(process.execPath, [path.join(scratchRoot, 'bin/cli.cjs'), '--json', ...args])).stdout);
    const target = (await cli(['scope', 'resolve', '--repo', fixture.project])).targets[0].repository_id;
    const parent = async (action = 'allow') => unwrap(await client.session.create({ body: { title: 'Capture pipeline', permission: [
      { permission: 'memocap_remember', pattern: '*', action: 'allow' }, { permission: 'memocap_remember', pattern: target, action },
    ] } }));
    const prompt = async (session, text) => unwrap(await client.session.prompt({ path: { id: session.id }, body: {
      model, agent: 'build', parts: [{ type: 'text', text }],
    } }));
    const review = (session, after = 0) => control.wait((event) => control.events.indexOf(event) >= after &&
      event.phase === 'capture.review' && event.payload.context.session_id === session.id);
    const commit = (change) => ({ tool: 'memocap_remember', get args() {
      const args = JSON.parse(userText(provider.requests.at(-1))); return change ? change(args) : args;
    } });
    return { fixture, provider, control, client, model, unwrap, cli, target, parent, prompt, review, commit, close };
  } catch (error) { await close(); throw error; }
}
module.exports = { harness };
