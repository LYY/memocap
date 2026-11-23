const assert = require('node:assert/strict');
const path = require('node:path');
const { write } = require('../setup-package-lifecycle-fixture.cjs');
const { citation, meta, writes } = require('./helpers.cjs');
const { handshakeAbort, replayIdle, cancelAfterCommit } = require('../opencode-capture/cases.cjs');
const { nativeDenial, unknownReceipt, parentError, newInput } = require('../opencode-capture/races.cjs');

async function probes(current, evidence) {
  for (const [name, change, status, expected] of [
    ['forged_source', (packet) => ({ candidates: [{ statements: [{ text: 'Invented fact.', citations: [{ ...citation(packet.sources[0]), source_id: 'forged' }] }] }] }), null, 'evidence_mismatch'],
    ['unknown_support', undefined, 'unknown', 'unsupported'],
    ['unsupported_support', undefined, 'unsupported', 'unsupported'],
    ['no_candidate', () => ({ candidates: [] }), null, 'no_candidate'],
  ]) {
    const parent = await current.parent();
    const start = current.control.events.length;
    const before = writes(current.control);
    current.reviewSupport = status ? (result) => ({ ...result, statements: [{ index: 0, status }] }) : undefined;
    current.provider.responses.push({ text: 'Confirmed.' }, current.extract(change));
    await current.prompt(parent, `For future work, prefer concise Chinese for ${name}.`);
    const review = await current.review(parent, start);
    assert.equal(meta(review).reason, expected);
    assert.equal(writes(current.control), before);
    evidence.cases.push({ name, review: meta(review) });
    current.provider.responses.length = 0;
  }
  current.reviewSupport = undefined;
  const parent = await current.parent();
  const start = current.control.events.length;
  const before = writes(current.control);
  current.control.settings.retractAtAsk = true;
  current.provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit());
  await current.prompt(parent, 'Prefer concise Chinese for the source retraction fixture.');
  const retracted = await current.review(parent, start);
  assert.equal(meta(retracted).reason, 'source_changed');
  assert.equal(writes(current.control), before);
  evidence.cases.push({ name: 'source_retraction_after_native_ask_before_spawn', review: meta(retracted) });
  current.control.settings.retractAtAsk = false;
  current.provider.responses.length = 0;
  for (const run of [handshakeAbort, replayIdle, nativeDenial, newInput, cancelAfterCommit,
    async (c, e) => cancelAfterCommit(c, e, true), unknownReceipt, parentError]) {
    process.stderr.write(`WORKING pipeline host ${evidence.host.version}: ${run.name || 'child_after_write'}\n`);
    await run(current, evidence);
    current.provider.responses.length = 0;
  }
}

async function identity(current, evidence) {
  const directory = current.fixture.project;
  const first = path.join(directory, 'identity-a.md');
  const second = path.join(directory, 'identity-b.md');
  const text = 'Alpha requires approval. Beta is prohibited.';
  write(first, text); write(second, text);
  const before = writes(current.control);
  for (const [filePath, statement, expected] of [[first, 'Alpha requires approval.', 'saved_verified'],
    [first, 'Beta is prohibited.', 'saved_verified'], [second, 'Alpha requires approval.', 'duplicate_body']]) {
    const parent = await current.parent();
    const start = current.control.events.length;
    current.provider.responses.push({ tool: 'read', args: { filePath } }, { text: 'Read complete.' }, current.extract((packet) => {
      const source = packet.sources.find((entry) => entry.kind === 'file_content');
      assert.ok(source, JSON.stringify(packet));
      return { candidates: [{ statements: [{ text: statement, citations: [citation(source)] }] }] };
    }), current.commit(), { text: 'Blocked fourth.' });
    await current.prompt(parent, `Read ${filePath} and preserve its alpha and beta conditions.`);
    const review = await current.review(parent, start);
    assert.equal(meta(review).reason, expected, JSON.stringify(meta(review)));
    evidence.cases.push({ name: 'substantive_identity', statement, filePath, review: meta(review) });
    current.provider.responses.length = 0;
  }
  assert.equal(writes(current.control) - before, 2);
}
module.exports = { probes, identity };
