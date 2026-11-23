"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { digest, mergeHostConfig, snapshot } = require('../packaged-runtime.cjs');
const { wireProvider, startHost, portClosed } = require('../opencode-v1/host.cjs');
const { extractionReply, supportReply, proposal } = require('../opencode-capture/harness.cjs');
const { reference, assertLibraryReference } = require('../opencode-v1/discovery.cjs');
function verifyRead(receipt, expected) {
  assert.equal(receipt.status, 'ok');
  assert.deepEqual(receipt.returned_ids, [expected.id]);
  const result = receipt.results.find(entry => entry.memory.id === expected.id);
  assert.ok(result); assert.equal(result.completeness, 'full');
  assert.equal(result.content_hash, expected.content_hash);
  assert.equal(digest(result.memory.content), expected.content_hash);
  for (const field of ['id', 'placement', 'content', 'tags']) assert.equal(result.memory[field], expected[field], field);
}
function verifyCapture(receipt, expected) {
  assert.equal(receipt.status, 'inserted');
  assert.deepEqual(receipt.returned_ids, [expected.id]);
  verifyRead(receipt.readback, expected);
}
function captureExpectation(packet, placement) {
  const source = packet.sources.find(entry => entry.user_id === packet.current_user_id);
  const candidate = proposal(packet, source).candidates[0];
  const text = source.text;
  const citation = candidate.statements[0].citations[0];
  const excerpt = [...citation.quote].slice(0, 32).join('');
  const content = text + '\n\nCapture sources: ' + JSON.stringify({ statements: [text.length], citations: [{
    content_hash: citation.content_hash, span: [citation.span.start, citation.span.start + [...excerpt].length],
    excerpt, fragment: true, type: source.pointer.type, locator: source.pointer.locator,
    observed_at: source.pointer.observed_at,
    ...(source.pointer.line_range ? { lines: [source.pointer.line_range.start, source.pointer.line_range.end] } : {}) }] });
  return { placement, content, content_hash: digest(content),
    tags: `memocap-capture-${digest(JSON.stringify([placement, [text.replace(/\r\n?/g, '\n').trim()]]))}` };
}
function reviewCompletion(fixture, session, observed) {
  let watcher;
  let timer;
  const pending = new Promise((resolve, reject) => {
    const inspect = () => {
      try {
        const rows = fixture.database().tables.activity_events;
        const event = rows.map(row => JSON.parse(row.event_json)).find(value => value.detail?.phase === 'capture_review' &&
          value.context?.session_id === session.id);
        if (event) { observed.review = event; resolve(event); }
      } catch (error) { reject(error); }
    };
    watcher = fs.watch(fixture.env.MEMOCAP_DATA_DIR, inspect);
    timer = setTimeout(() => reject(new Error('capture review completion timed out')), 90000);
    inspect();
  });
  return { pending, close() { watcher.close(); clearTimeout(timer); } };
}
async function installedSDK(fixture) {
  const resolved = await fixture.command(process.execPath, ['--input-type=module', '--eval', `
    import { findPackageJSON } from 'node:module';
    import { readFileSync } from 'node:fs';
    const url = import.meta.resolve('@opencode-ai/sdk');
    const metadata = JSON.parse(readFileSync(findPackageJSON('@opencode-ai/sdk', import.meta.url), 'utf8'));
    process.stdout.write(JSON.stringify({ url, name: metadata.name, version: metadata.version }));
  `], { cwd: fixture.installedRoot, timeout: 10000 });
  const sdk = JSON.parse(resolved.stdout);
  assert.equal(sdk.name, '@opencode-ai/sdk');
  assert.equal(sdk.version, '1.19.3');
  return import(sdk.url);
}
async function runtime(fixture, staticProof) {
  const evidence = fixture.evidence;
  let host, provider, completion;
  const observed = { messages: [], genuine_model_calls: 0, model_quality: 'not_evaluated' };
  const hostCommand = { executable: fixture.host, args: [], exit_code: null };
  evidence.runtime = observed;
  try {
    provider = await wireProvider();
    evidence.commands.push(hostCommand);
    host = await startHost(fixture, provider, evidence);
    hostCommand.args = ['serve', '--hostname=127.0.0.1', `--port=${new URL(evidence.host.url).port}`, '--print-logs'];
    mergeHostConfig(fixture.config, { permission: { ...require('jsonc-parser').parse(fs.readFileSync(fixture.config, 'utf8')).permission,
      custom_tool: { 'private/*': 'deny' } } });
    const { createOpencodeClient } = await installedSDK(fixture);
    const clientFor = directory => createOpencodeClient({ baseUrl: evidence.host.url, directory });
    const unwrap = result => { assert.equal(result.error, undefined, JSON.stringify(result.error)); return result.data; };
    const client = clientFor(fixture.directories.A);
    const session = unwrap(await client.session.create({ body: { title: 'Published QA8 project A' } }));
    const resolved = await fixture.cli(['scope', 'resolve', '--repo', fixture.directories.A]);
    const placement = resolved.targets[0].repository_id;
    const token = `publishedquartz${require('node:crypto').randomBytes(8).toString('hex')}`;
    const text = `For ${token}, always use a dedicated blue notebook to record durable project decisions.`;
    const nextID = Math.max(0, ...fixture.database().tables.memories.map(row => row.id)) + 1;
    let expected;
    provider.responses.push({ text: 'Preference understood.' }, extractionReply(provider, packet => {
      expected = { ...captureExpectation(packet, placement), id: nextID };
      assert.equal(packet.sources.find(source => source.user_id === packet.current_user_id).text, text);
      observed.extraction = packet;
      return proposal(packet, packet.sources.find(source => source.user_id === packet.current_user_id));
    }), supportReply(provider), { tool: 'memocap_remember', get args() {
      const message = provider.requests.at(-1).body.messages.findLast(value => value.role === 'user');
      const args = JSON.parse(typeof message.content === 'string' ? message.content : message.content.filter(p => p.type === 'text').map(p => p.text).join(''));
      assert.equal(args.content, expected.content);
      observed.issued = args;
      return args;
    } }, { text: 'Capture committed.' });
    completion = reviewCompletion(fixture, session, observed);
    const model = { providerID: 'wire', modelID: 'wire-model' };
    const prompt = (selected, id, value) => selected.session.prompt({ path: { id }, signal: AbortSignal.timeout(90000),
      body: { model, agent: 'build', parts: [{ type: 'text', text: value }] } }).then(unwrap);
    const reply = await prompt(client, session.id, text);
    assert.equal(reply.info.error, undefined);
    const review = await completion.pending;
    completion.close(); completion = undefined;
    assert.equal(review.detail.metadata.status, 'saved');
    assert.equal(review.context.message_id, observed.extraction.current_user_id);
    assert.equal(review.detail.metadata.write_attempts, 1);
    assert.deepEqual(review.detail.metadata.memory_ids, [nextID]);
    const children = unwrap(await client.session.children({ path: { id: session.id } }));
    observed.messages = (await Promise.all(children.map(child => client.session.messages({ path: { id: child.id } }).then(unwrap)))).flat();
    const tool = observed.messages.flatMap(message => message.parts).findLast(part => part?.type === 'tool' &&
      part.tool === 'memocap_remember' && part.state.status === 'completed');
    assert.ok(tool, 'actual completed native tool receipt required');
    observed.native = JSON.parse(tool.state.output);
    verifyCapture(observed.native, expected);
    observed.readback = await fixture.cli(['read', String(expected.id), '--placement', placement]);
    assert.equal(observed.readback.status, 'ok');
    assert.deepEqual(observed.readback.returned_ids, [nextID]);
    const independent = observed.readback.results[0].memory;
    for (const field of ['id', 'placement', 'content', 'tags']) assert.equal(independent[field], expected[field]);
    assert.equal(digest(independent.content), expected.content_hash);
    const row = fixture.database().tables.memories.find(memory => memory.id === expected.id);
    for (const field of ['id', 'content', 'tags']) assert.equal(row[field], expected[field]);
    assert.equal(row.placement_kind, 'repository'); assert.equal(row.repository_id, placement);
    const projectB = clientFor(fixture.directories.B);
    const other = unwrap(await projectB.session.create({ body: { title: 'Published QA8 project B' } }));
    observed.sessions = { projectA: session, projectB: other, actual_user_id: observed.extraction.current_user_id };
    provider.responses.push({ get tool() { return 'memocap_read'; }, get args() {
      const receipt = provider.requests.at(-1).body.messages.map(reference).findLast(Boolean);
      assertLibraryReference(receipt, expected); observed.library = receipt;
      return receipt.references[0].read.arguments;
    } }, { text: 'Cross-project full read completed.' }, { text: JSON.stringify({ candidates: [] }) });
    await prompt(projectB, other.id, token);
    const messages = unwrap(await projectB.session.messages({ path: { id: other.id } }));
    const readTool = messages.flatMap(message => message.parts).findLast(part => part.type === 'tool' && part.tool === 'memocap_read');
    assert.equal(readTool.state.status, 'completed');
    observed.cross_project_read = JSON.parse(readTool.state.output);
    verifyRead(observed.cross_project_read, expected);
    assert.deepEqual((await fixture.cli(['list', '--repo', fixture.directories.B])).returned_ids, []);
    const version = staticProof.doctor.runner_version;
    const cache = path.join(fixture.env.XDG_CACHE_HOME, 'opencode/packages', `@lyy-gh/memocap@${version}/node_modules/@lyy-gh/memocap`);
    observed.loaded = { path: cache, plugin: digest(fs.readFileSync(path.join(cache, 'plugin/index.js'))) };
    const loadedFiles = snapshot([cache]);
    for (const [filename, hash] of Object.entries(staticProof.files)) assert.equal(loadedFiles[path.join(cache, filename)], hash, filename);
    assert.equal(observed.loaded.plugin, staticProof.files[path.join('plugin', 'index.js')]);
    const { inspectPolicy } = await import(pathToFileURL(path.join(cache, 'lib/policy.mjs')));
    assert.equal(inspectPolicy(path.join(cache, 'skills/memocap')).digest, staticProof.managed.policy.digest);
    const statusSession = unwrap(await projectB.session.create({ body: { title: 'Published runtime policy readback' } }));
    provider.responses.push({ get text() {
      const message = provider.requests.at(-1).body.messages.findLast(entry => entry.role === 'user');
      observed.policy = JSON.parse(message.content);
      return 'Runtime policy read back.';
    } });
    unwrap(await projectB.session.command({ path: { id: statusSession.id }, body: { command: 'memory', arguments: 'status', model: 'wire/wire-model' } }));
    assert.equal(observed.policy.policy.mode, 'managed');
    assert.equal(observed.policy.policy.version, version);
    assert.equal(observed.policy.policy.digest, staticProof.managed.policy.digest);
    assert.equal(fs.realpathSync(observed.policy.policy.directory), fs.realpathSync(staticProof.managed.policy.directory));
    observed.expected = expected; observed.provider_requests = provider.requests;
    assert.deepEqual(provider.errors, []);
  } finally {
    completion?.close();
    const stopped = await Promise.allSettled([host?.close(), provider?.close()]);
    hostCommand.exit_code = evidence.host?.exit?.code ?? null;
    hostCommand.signal = evidence.host?.exit?.signal ?? null;
    evidence.cleanup.host_port_closed = evidence.host?.url ? await portClosed(evidence.host.url) : true;
    evidence.cleanup.provider_port_closed = provider ? await portClosed(provider.url) : true;
    const failures = stopped.filter(result => result.status === 'rejected');
    assert.equal(failures.length, 0, JSON.stringify(failures.map(result => String(result.reason))));
  }
}
module.exports = { verifyRead, verifyCapture, captureExpectation, installedSDK, runtime };
