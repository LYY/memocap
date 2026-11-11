const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { lifecycleFixture, digest, write } = require('../setup-package-lifecycle-fixture.cjs');
const { wireProvider, startHost, portClosed } = require('../opencode-v1/host.cjs');
const { controlServer } = require('../opencode-capture-spike/control.cjs');
const repo = path.resolve(__dirname, '../..');

function userText(request) {
  const content = request.body.messages.findLast((message) => message.role === 'user').content;
  return typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join('');
}

async function harness(evidence) {
  const fixture = lifecycleFixture(repo, evidence);
  let host;
  let provider;
  let control;
  const close = async () => {
    control?.releaseAll();
    if (host) await host.close();
    if (provider) await provider.close();
    if (control) await control.close();
    evidence.cleanup.host_port_closed = evidence.host?.url ? await portClosed(evidence.host.url) : true;
    evidence.cleanup.provider_port_closed = provider ? await portClosed(provider.url) : true;
    evidence.cleanup.package = await fixture.cleanup();
  };
  try {
    const prepared = await fixture.prepare();
    control = await controlServer();
    provider = await wireProvider();
    const config = path.join(fixture.env.XDG_CONFIG_HOME, 'opencode/opencode.json');
    const marker = path.join(fixture.root, 'native-handshake-marker');
    const probeOptions = path.join(fixture.root, 'native-probe.json');
    write(probeOptions, JSON.stringify({ control: control.url, marker,
      native: path.join(repo, 'target/debug/memocap') }));
    const cached = path.join(fixture.home, 'Library/Caches/memocap', fixture.version, 'memocap-aarch64-apple-darwin');
    write(cached, `#!${process.execPath}\nprocess.argv.splice(2,0,${JSON.stringify(probeOptions)});require(${JSON.stringify(path.join(__dirname, 'native-probe.cjs'))});\n`);
    fs.chmodSync(cached, 0o755);
    write(`${cached}.sha256`, `${digest(fs.readFileSync(cached))}  ${path.basename(cached)}\n`);
    write(config, JSON.stringify({ share: 'disabled', plugin: [[pathToFileURL(path.join(__dirname, 'observer.mjs')).href,
      { control: control.url, marker, plugin: pathToFileURL(path.join(prepared.runnerRoot, 'plugin/cli.js')).href }]] }));
    const packagedHost = process.env.MEMOCAP_CAPTURE_PACKAGED_HOST === '1';
    const executable = packagedHost ? prepared.host : '/opt/homebrew/bin/opencode';
    evidence.actual_version = (await fixture.command(executable, ['--version'])).stdout.trim();
    assert.equal(evidence.actual_version, packagedHost ? '1.19.3' : '1.19.5');
    evidence.host = { version: evidence.actual_version, sha256: digest(fs.readFileSync(executable)),
      origin: packagedHost ? 'official_opencode_ai_npm_platform_dependency' : 'existing_local_host' };
    host = await startHost({ env: fixture.env, config, host: executable, directories: { outside: fixture.project } }, provider, evidence);
    const sdkRoot = path.resolve(prepared.runnerRoot, '../../@opencode-ai/sdk');
    const sdk = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json')));
    const { createOpencodeClient } = await import(pathToFileURL(path.join(sdkRoot, sdk.exports['.'].import)));
    const clientFor = (directory) => createOpencodeClient({ baseUrl: evidence.host.url, directory });
    const client = clientFor(fixture.project);
    const unwrap = (result) => { assert.equal(result.error, undefined, JSON.stringify(result.error)); return result.data; };
    const model = { providerID: 'wire', modelID: 'wire-model' };
    const cli = async (args) => JSON.parse((await fixture.command(process.execPath, [path.join(prepared.runnerRoot, 'bin/cli.cjs'), '--json', ...args])).stdout);
    const target = (await cli(['scope', 'resolve', '--repo', fixture.project])).targets[0].repository_id;
    const extract = (change) => {
      return { get text() {
        const request = provider.requests.at(-1);
        const parsed = JSON.parse(userText(request));
        const selected = parsed.evidence[0];
        return JSON.stringify(change ? change(parsed) : { candidates: [{ evidence: [{ sourceId: selected.sourceId, quote: selected.text }] }] });
      } };
    };
    const commit = (change) => {
      return { tool: 'memocap_remember', get args() {
        const args = JSON.parse(userText(provider.requests.at(-1)));
        return change ? change(args) : args;
      } };
    };
    const parent = async (action = 'allow') => {
      return unwrap(await client.session.create({ body: { title: 'Automatic capture E2E', permission: [
        { permission: 'memocap_remember', pattern: '*', action: 'allow' },
        ...(action !== 'allow' ? [{ permission: 'memocap_remember', pattern: target, action: action === true ? 'deny' : action }] : []),
      ] } }));
    };
    const prompt = async (session, text) => {
      return unwrap(await client.session.prompt({ path: { id: session.id }, body: { model, agent: 'build', parts: [{ type: 'text', text }] } }));
    };
    const review = async (session, after = 0) => {
      return control.wait((event) => control.events.indexOf(event) >= after && event.phase === 'capture.review' && event.payload.context.session_id === session.id);
    };
    return { fixture, provider, control, client, clientFor, model, host, unwrap, cli, target, extract, commit, parent, prompt, review, close };
  } catch (error) { await close(); throw error; }
}
module.exports = { harness };
