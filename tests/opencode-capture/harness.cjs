const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { lifecycleFixture, digest, write } = require('../setup-package-lifecycle-fixture.cjs');
const { wireProvider, startHost, portClosed } = require('../opencode-v1/host.cjs');
const { controlServer } = require('../opencode-capture-spike/control.cjs');
const { isSupportedHost } = require('../../lib/opencode-host.js');
const repo = path.resolve(__dirname, '../..');

function userText(request) {
  const content = request.body.messages.findLast((message) => message.role === 'user').content;
  return typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join('');
}

function extractionReply(provider, change) {
  return { get text() {
    const parsed = JSON.parse(userText(provider.requests.at(-1)));
    const selected = parsed.sources.find((source) => source.user_id === parsed.current_user_id);
    return JSON.stringify(change ? change(parsed) : proposal(parsed, selected));
  } };
}

function proposal(packet, source, text = source.text) {
  const unit = packet.bundles.find((bundle) => bundle.source_id === source.source_id).units[0];
  const span = unit.span;
  const quote = [...source.text].slice(span.start, span.end).join('');
  return { candidates: [{ statements: [{ text, citations: [{ source_id: source.source_id,
    content_hash: source.content_hash, span, quote }] }] }] };
}

function supportReply(provider) {
  return { get text() {
    const request = provider.requests.at(-1);
    const packet = JSON.parse(userText(request));
    assert.match(packet.evidence_packet_sha256, /^[a-f0-9]{64}$/);
    const messages = request.body.messages;
    const reviewIndex = messages.findLastIndex((message) => message.role === 'user');
    const matches = messages.slice(0, reviewIndex).flatMap((message, index) => {
      if (message.role !== 'user') return [];
      const text = userText({ body: { messages: [message] } });
      return digest(text) === packet.evidence_packet_sha256 ? [{ text, index }] : [];
    });
    assert.equal(matches.length, 1, 'support requires one exact prior evidence packet in this request');
    assert.equal(matches[0].index, messages.findIndex((message) => message.role === 'user'));
    const initial = JSON.parse(matches[0].text);
    const citations = packet.candidate.statements.flatMap((statement) => statement.citations);
    const owners = citations.map((citation) => {
      const sources = initial.sources.filter((source) => source.source_id === citation.source_id);
      assert.equal(sources.length, 1);
      const source = sources[0];
      assert.equal(source.content_hash, citation.content_hash);
      assert.ok(Number.isInteger(citation.span.start) && Number.isInteger(citation.span.end) &&
        citation.span.start >= 0 && citation.span.end > citation.span.start && citation.span.end <= [...source.text].length);
      assert.equal([...source.text].slice(citation.span.start, citation.span.end).join(''), citation.quote);
      return source.user_id;
    });
    const expected = { evidence_packet_sha256: digest(matches[0].text), persisted_body: packet.persisted_body,
      candidate: packet.candidate, citation_roles: packet.candidate.statements.flatMap((statement, statement_index) =>
        statement.citations.map((citation, citation_index) => ({ statement_index, citation_index,
          role: initial.sources.find((source) => source.source_id === citation.source_id).user_id === initial.current_user_id ? 'current' : 'prior' }))) };
    const witnessID = digest(JSON.stringify(expected));
    assert.deepEqual(packet, { ...expected, witness_id: witnessID });
    provider.support_history ??= [];
    provider.support_history.push({ request_index: provider.requests.length - 1,
      initial_packet_sha256: packet.evidence_packet_sha256, initial_message_index: matches[0].index,
      support_message_index: reviewIndex, source_count: initial.sources.length, citation_count: citations.length });
    const currentOnly = owners.every((owner) => owner === initial.current_user_id);
    const hasPriorSources = initial.sources.some((source) => source.user_id !== initial.current_user_id);
    return JSON.stringify({ memory: { status: 'accept' },
      statements: packet.candidate.statements.map((_, index) => ({ index, status: 'supported' })),
      continuity: hasPriorSources ? { status: currentOnly ? 'standalone' : 'supported', witness_id: witnessID } : { status: 'current' } });
  } };
}

async function harness(evidence) {
  const { MEMOCAP_CAPTURE_HOST_EXECUTABLE: explicitHost, MEMOCAP_CAPTURE_HOST_EXPECTED_VERSION: explicitVersion } = process.env;
  if (explicitHost !== undefined || explicitVersion !== undefined) {
    assert.ok(explicitHost && explicitVersion, 'MEMOCAP_CAPTURE_HOST_EXECUTABLE and MEMOCAP_CAPTURE_HOST_EXPECTED_VERSION must be set together');
    assert.ok(path.isAbsolute(explicitHost), 'explicit host executable must be an absolute path');
    assert.ok(isSupportedHost(explicitVersion), 'expected host version must be an exact OpenCode v1 version');
  }
  const fixture = lifecycleFixture(repo, evidence);
  fixture.env.npm_config_offline = 'true';
  let host;
  let provider;
  let control;
  const orderLog = path.join(fixture.root, 'tool-order.jsonl');
  const toolOrder = () => fs.existsSync(orderLog) ? fs.readFileSync(orderLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const captureEvents = (after = 0) => structuredClone((control?.events ?? []).slice(after)
    .filter((event) => event.phase !== 'host.event').map((event) => event.phase !== 'remember.result' ? event : {
      phase: event.phase, sessionID: event.sessionID, receipt: { status: event.receipt.status, error: event.receipt.error,
        returned_ids: event.receipt.returned_ids, readback: event.receipt.readback && { status: event.receipt.readback.status,
          results: event.receipt.readback.results?.map(({ memory }) => ({ id: memory.id, placement: memory.placement,
            content_hash: digest(JSON.stringify(memory.content)), tags: memory.tags })) } } }));
  const close = async () => {
    control?.releaseAll();
    if (host) await host.close();
    if (provider) await provider.close();
    if (control) await control.close();
    evidence.cleanup.host_port_closed = evidence.host?.url ? await portClosed(evidence.host.url) : true;
    evidence.cleanup.provider_port_closed = provider ? await portClosed(provider.url) : true;
    evidence.cleanup.control_port_closed = control ? await portClosed(control.url) : true;
    evidence.tool_order = toolOrder();
    evidence.control_events = captureEvents();
    evidence.support_history = provider?.support_history ?? [];
    evidence.cleanup.sandbox = fixture.root;
    evidence.cleanup.urls = { host: evidence.host?.url, provider: provider?.url, control: control?.url };
    evidence.cleanup.package = await fixture.cleanup();
  };
  try {
    const prepared = await fixture.prepare({ installPackagedHost: !explicitHost });
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
      { control: control.url, marker, orderLog, plugin: pathToFileURL(path.join(prepared.runnerRoot, 'plugin/cli.js')).href }]] }));
    const packagedHost = process.env.MEMOCAP_CAPTURE_PACKAGED_HOST === '1';
    const executable = explicitHost ? fs.realpathSync(explicitHost) : packagedHost ? prepared.host : '/opt/homebrew/bin/opencode';
    const pinned = explicitHost ? digest(fs.readFileSync(executable)) : undefined;
    evidence.actual_version = (await fixture.command(executable, ['--version'])).stdout.trim();
    assert.equal(evidence.actual_version, explicitVersion ?? (packagedHost ? '1.19.3' : '1.19.5'), 'selected host must report the exact fixture version');
    evidence.host = { version: evidence.actual_version, sha256: digest(fs.readFileSync(executable)),
      origin: explicitHost ? 'explicit_selected_host' : packagedHost ? 'official_opencode_ai_npm_platform_dependency' : 'existing_local_host' };
    if (explicitHost) {
      assert.equal(fs.realpathSync(explicitHost), executable, 'selected host path changed');
      assert.equal(evidence.host.sha256, pinned, 'selected host bytes changed');
      evidence.host.executable = executable;
    }
    host = await startHost({ env: fixture.env, config, host: executable, directories: { outside: fixture.project } }, provider, evidence);
    const sdkRoot = path.resolve(prepared.runnerRoot, '../../@opencode-ai/sdk');
    const sdk = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json')));
    evidence.sdk = { version: sdk.version, package_json_sha256: digest(fs.readFileSync(path.join(sdkRoot, 'package.json'))) };
    assert.equal(sdk.version, '1.19.3');
    const { createOpencodeClient } = await import(pathToFileURL(path.join(sdkRoot, sdk.exports['.'].import)));
    const clientFor = (directory) => createOpencodeClient({ baseUrl: evidence.host.url, directory });
    const client = clientFor(fixture.project);
    const unwrap = (result) => { assert.equal(result.error, undefined, JSON.stringify(result.error)); return result.data; };
    const model = { providerID: 'wire', modelID: 'wire-model' };
    const cli = async (args) => JSON.parse((await fixture.command(process.execPath, [path.join(prepared.runnerRoot, 'bin/cli.cjs'), '--json', ...args])).stdout);
    const target = (await cli(['scope', 'resolve', '--repo', fixture.project])).targets[0].repository_id;
    const extract = (change) => extractionReply(provider, change);
    const support = () => supportReply(provider);
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
    return { fixture, provider, control, client, clientFor, model, host, unwrap, cli, target, extract, support, commit, parent, prompt, review, close, toolOrder, captureEvents };
  } catch (error) { await close(); throw error; }
}
module.exports = { harness, extractionReply, supportReply, proposal };
