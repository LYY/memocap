const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { digest } = require('../packaged-runtime.cjs');
const { reference } = require('../opencode-v1/discovery.cjs');
const { assertDirectoryTargets } = require('../opencode-v1/paths.cjs');
const { meta, writes } = require('./cases.cjs');

async function crossProject(current, evidence, source) {
  const { provider, unwrap, cli } = current;
  const { id, placement, content } = source.saved;
  const contentHash = digest(content);
  assert.deepEqual(source.review.memory_ids, [id]);
  assert.equal(placement, current.target);
  const before = writes(current.control);
  const inventory = await cli(['list', '--placement', placement]);
  const directory = path.join(current.fixture.root, 'new project B');
  fs.mkdirSync(directory);
  const client = current.clientFor(directory);
  const session = unwrap(await client.session.create({ body: { title: 'Captured route cross-project recall' } }));
  assertDirectoryTargets([session.directory], [directory]);
  assert.notEqual(session.directory, source.parent.directory);
  assert.equal(session.parentID, undefined);
  const target = (await cli(['scope', 'resolve', '--repo', directory])).targets[0].repository_id;
  assert.notEqual(target, placement);
  const query = 'Where can I start an alpha release?';
  let injected;
  let entry;
  assert.equal(provider.responses.length, 0);
  provider.responses.push({ get tool() {
    injected = reference(provider.requests.at(-1).body.messages.findLast((message) => message.role === 'user'));
    assert.ok(injected, 'project B must receive an automatic reference before any tool call');
    assert.equal(injected.status, 'ok');
    assert.deepEqual(injected.discovery, { kind: 'library' });
    entry = injected.references.find((candidate) => candidate.id === id && candidate.placement === placement);
    assert.ok(entry, JSON.stringify(injected));
    assert.ok(injected.returned_ids.includes(id));
    assert.equal(entry.content, content);
    assert.equal(entry.content_hash, contentHash);
    assert.equal(entry.completeness, 'full');
    assert.equal(entry.applicability, 'unknown');
    assert.deepEqual(entry.read, { tool: 'memocap_read', arguments: { id, placement, content_hash: contentHash } });
    return entry.read.tool;
  }, get args() { return entry.read.arguments; } }, { text: 'Full captured route read; approval and beta restrictions retained.' },
  current.extract(() => ({ candidates: [] })));
  const reply = unwrap(await client.session.prompt({ path: { id: session.id }, body: {
    model: current.model, agent: 'build', parts: [{ type: 'text', text: query }],
  } }));
  assert.equal(reply.info.error, undefined, JSON.stringify(reply.info.error));
  const review = meta(await current.review(session));
  assert.equal(review.reason, 'no_candidate', JSON.stringify(review));
  assert.equal(review.write_attempts, 0);
  assert.deepEqual(review.memory_ids, []);
  assert.equal(provider.responses.length, 0, 'project B review must finish before later scenarios enqueue responses');
  const messages = unwrap(await client.session.messages({ path: { id: session.id } }));
  const calls = messages.flatMap((message) => message.parts).filter((part) => part.type === 'tool');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.tool, 'memocap_read');
  assert.equal(call.state.status, 'completed', JSON.stringify(call));
  assert.deepEqual(call.state.input, entry.read.arguments);
  const receipt = JSON.parse(call.state.output);
  assert.equal(receipt.status, 'ok');
  assert.deepEqual(receipt.returned_ids, [id]);
  assert.deepEqual(receipt.targets.map((item) => item.repository_id), [target]);
  assert.equal(receipt.results.length, 1);
  const full = receipt.results[0];
  assert.equal(full.memory.id, id);
  assert.equal(full.memory.placement, placement);
  assert.equal(full.memory.content, content);
  assert.equal(full.completeness, 'full');
  assert.equal(full.content_hash, contentHash);
  assert.equal(digest(full.memory.content), contentHash);
  assert.equal(receipt.record_changed, false);
  assert.match(full.memory.content, /Approval required/);
  assert.match(full.memory.content, /Never use this entry for beta/);
  assert.equal(writes(current.control), before);
  assert.deepEqual((await cli(['list', '--placement', placement])).results, inventory.results);
  assert.deepEqual((await cli(['list', '--repo', directory])).results, []);
  evidence.cases.push({ name: 'actual_capture_project_A_to_new_project_B_automatic_recall_full_read',
    scripted_provider_verifies_host_workflow_not_ai_judgment: true,
    source: { directory: source.parent.directory, session_id: source.parent.id, id, placement, content_hash: contentHash,
      content, review: source.review },
    destination: { directory, session_id: session.id, target, query }, injected, read: receipt, review,
    extra_native_writes: writes(current.control) - before, extra_saved_memories: 0 });
}

module.exports = { crossProject };
