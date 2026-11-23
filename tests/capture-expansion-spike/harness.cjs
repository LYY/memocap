const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { lifecycleFixture, digest, write } = require('../setup-package-lifecycle-fixture.cjs');
const { wireProvider, startHost, portClosed } = require('../opencode-v1/host.cjs');
const { controlServer } = require('../opencode-capture-spike/control.cjs');
const { prototype } = require('./prototype.cjs');
const { packageSource } = require('./package-source.cjs');
const repo = path.resolve(__dirname, '../..');

const userText = (request) => {
  const content = request.body.messages.findLast((message) => message.role === 'user').content;
  return typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join('');
};

async function harness(evidence, scratch) {
  const fixture = lifecycleFixture(repo, evidence);
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
    const link = path.join(scratchRoot, 'node_modules');
    fs.rmSync(link, { force: true });
    evidence.cleanup.scratch_dependency_link_removed = true;
  };
  try {
    const prepared = await fixture.prepare();
    packageSource(prepared, scratchRoot, evidence);
    evidence.original_capture_hashes = Object.fromEntries(['worker', 'binding', 'index', 'lifecycle', 'contract'].map((name) =>
      [name, digest(fs.readFileSync(path.join(scratchRoot, `plugin/capture/${name}.js`)))]));
    evidence.delta = evidence.mode === 'scratch_prototype' ? prototype(scratchRoot) : [];
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
      { control: control.url, marker, plugin: pathToFileURL(path.join(scratchRoot, 'plugin/cli.js')).href,
        observedModule: evidence.mode === 'scratch_prototype'
          ? pathToFileURL(path.join(scratchRoot, 'plugin/capture/spike-observed.js')).href : undefined }]] }));
    const packaged = process.env.MEMOCAP_CAPTURE_PACKAGED_HOST === '1';
    const executable = packaged ? prepared.host : '/opt/homebrew/bin/opencode';
    const version = (await fixture.command(executable, ['--version'])).stdout.trim();
    assert.equal(version, packaged ? '1.19.3' : '1.19.5');
    evidence.host = { version, sha256: digest(fs.readFileSync(executable)), origin: packaged ? 'official_npm_platform_dependency' : 'existing_local_host' };
    host = await startHost({ env: fixture.env, config, host: executable, directories: { outside: fixture.project } }, provider, evidence);
    const sdkRoot = path.join(dependencies, '@opencode-ai/sdk');
    const sdk = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json')));
    const { createOpencodeClient } = await import(pathToFileURL(path.join(sdkRoot, sdk.exports['.'].import)));
    const client = createOpencodeClient({ baseUrl: evidence.host.url, directory: fixture.project });
    const unwrap = (result) => { assert.equal(result.error, undefined, JSON.stringify(result.error)); return result.data; };
    const model = { providerID: 'wire', modelID: 'wire-model' };
    const cli = async (args) => JSON.parse((await fixture.command(process.execPath, [path.join(scratchRoot, 'bin/cli.cjs'), '--json', ...args])).stdout);
    const target = (await cli(['scope', 'resolve', '--repo', fixture.project])).targets[0].repository_id;
    const parent = async (action = 'allow') => unwrap(await client.session.create({ body: { title: 'Bounded spike', permission: [
      { permission: 'memocap_remember', pattern: '*', action: 'allow' },
      { permission: 'memocap_remember', pattern: target, action },
    ] } }));
    const prompt = async (session, text) => unwrap(await client.session.prompt({ path: { id: session.id }, body: {
      model, agent: 'build', parts: [{ type: 'text', text }],
    } }));
    const review = (session, after = 0) => control.wait((event) => control.events.indexOf(event) >= after &&
      event.phase === 'capture.review' && event.payload.context.session_id === session.id);
    const extract = (change) => ({ get text() {
      const packet = JSON.parse(userText(provider.requests.at(-1)));
      return JSON.stringify(change ? change(packet) : { candidates: [{ evidence: [{ sourceId: packet.evidence[0].sourceId, quote: packet.evidence[0].text }] }] });
    } });
    const commit = (change) => ({ tool: 'memocap_remember', get args() {
      const args = JSON.parse(userText(provider.requests.at(-1))); return change ? change(args) : args;
    } });
    return { fixture, provider, control, client, model, unwrap, cli, target, parent, prompt, review, extract, commit, close };
  } catch (error) { await close(); throw error; }
}
module.exports = { harness, userText };
