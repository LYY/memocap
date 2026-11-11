const assert = require('node:assert/strict');
const { digest } = require('../packaged-runtime.cjs');
const { assertDirectoryTargets } = require('./paths.cjs');

function reference(message) {
  const parts = typeof message.content === 'string' ? [message.content] :
    (message.content || []).filter((part) => part.type === 'text').map((part) => part.text);
  const text = parts.findLast((part) => part.startsWith('memocap reference data'));
  return text ? JSON.parse(text.slice(text.indexOf('\n') + 1)) : undefined;
}

function assertLibraryReference(receipt, seed) {
  assert.equal(receipt.status, 'ok');
  assert.deepEqual(receipt.discovery, { kind: 'library' });
  assert.deepEqual(receipt.returned_ids, [seed.id]);
  assert.equal(receipt.references.length, 1);
  const entry = receipt.references[0];
  assert.equal(entry.id, seed.id);
  assert.equal(entry.placement, seed.placement);
  assert.equal(entry.content, seed.content);
  assert.equal(entry.completeness, 'full');
  assert.equal(entry.content_hash, digest(seed.content));
  assert.deepEqual(entry.read, { tool: 'memocap_read', arguments: {
    id: seed.id, placement: seed.placement, content_hash: digest(seed.content) } });
  assert.equal(entry.applicability, 'unknown');
  assert.deepEqual(entry.applicable_repositories, []);
  assert.equal(receipt.truncated, false);
}

async function sessionIsolation(host, provider, expected) {
  const observations = [];
  for (const parentID of [undefined, expected.session.id]) {
    const session = await host.api('/session', { title: 'isolated library discovery', ...(parentID ? { parentID } : {}) });
    assert.equal(session.directory, expected.session.directory);
    const prompt = async (text) => {
      const reply = await host.api(`/session/${session.id}/message`, {
        model: { providerID: 'wire', modelID: 'wire-model' }, parts: [{ type: 'text', text }] });
      assert.equal(reply.info.error, undefined, JSON.stringify(reply.info.error));
      return reference(provider.requests.at(-1).body.messages.findLast((message) => message.role === 'user'));
    };
    const receipt = await prompt('wireseedquartz');
    assertLibraryReference(receipt, expected.seed);
    const command = await host.api(`/session/${session.id}/command`, {
      command: 'memory', arguments: 'status', model: 'wire/wire-model' });
    assert.equal(command.info.error, undefined, JSON.stringify(command.info.error));
    const status = JSON.parse(provider.requests.at(-1).body.messages.findLast((message) => message.role === 'user').content);
    assertDirectoryTargets(status.targets.map((target) => target.canonical_path), [session.directory]);
    assert.deepEqual(status.current.targets, status.targets.map((target) => target.repository_id));
    const ownOrigin = status.targets[0].repository_id;
    assert.notEqual(ownOrigin, expected.seed.placement);
    provider.responses.push({ tool: 'memocap_recall', args: { query: 'wireseedquartz', placements: [ownOrigin] } },
      { text: 'Exact origin discovery observed.' });
    await prompt('fixture exact origin recall');
    const messages = await host.api(`/session/${session.id}/message`);
    const tool = messages.flatMap((message) => message.parts).findLast((part) => part.type === 'tool' && part.tool === 'memocap_recall');
    assert.equal(tool?.state.status, 'completed', JSON.stringify(tool));
    const filtered = JSON.parse(tool.state.output);
    assert.equal(filtered.status, 'empty');
    assert.deepEqual(filtered.discovery, { kind: 'origins', placements: [ownOrigin] });
    assert.deepEqual(filtered.returned_ids, []);
    assert.deepEqual(filtered.results, []);
    assert.deepEqual(filtered.targets.map((target) => target.repository_id), status.current.targets);
    assertDirectoryTargets(filtered.targets.map((target) => target.canonical_path), [session.directory]);
    provider.responses.push({ tool: 'memocap_recall', args: { query: 'wireseedquartz', library: true } },
      { text: 'Library discovery restored.' });
    await prompt('fixture restore library discovery');
    assertLibraryReference(await prompt('wireseedquartz'), expected.seed);
    observations.push({ session_id: session.id, targets: status.targets, receipt, filtered });
  }
  return observations;
}

module.exports = { reference, assertLibraryReference, sessionIsolation };
