const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { userText } = require('../capture-expansion-spike/harness.cjs');
const { meta, writes } = require('../opencode-capture/cases.cjs');

const citation = (source, start = 0, end = [...source.text].length) => ({ source_id: source.source_id,
  content_hash: source.content_hash, span: { start, end }, quote: [...source.text].slice(start, end).join('') });
const packet = (current) => JSON.parse(userText(current.provider.requests.at(-1)));
function pipeline(current) {
  current.extract = (change) => ({ get text() {
    const context = packet(current);
    const source = context.sources.find((entry) => entry.user_id === context.current_user_id && entry.kind === 'user_statement');
    const proposal = change ? change(context) : { candidates: [{ statements: [{ text: `Preference: ${source.text}`, citations: [citation(source)] }] }] };
    if (proposal.candidates?.length && current.provider.responses[0]?.stage !== 'support') current.provider.responses.unshift(current.support());
    return JSON.stringify(proposal);
  } });
  current.support = (change) => ({ stage: 'support', get text() {
    const context = packet(current);
    assert.match(context.evidence_packet_sha256, /^[a-f0-9]{64}$/);
    const messages = current.provider.requests.at(-1).body.messages;
    const reviewIndex = messages.findLastIndex((message) => message.role === 'user');
    const matches = messages.slice(0, reviewIndex).flatMap((message, index) => {
      if (message.role !== 'user') return [];
      const text = userText({ body: { messages: [message] } });
      return createHash('sha256').update(text).digest('hex') === context.evidence_packet_sha256 ? [{ text, index }] : [];
    });
    assert.equal(matches.length, 1, 'support requires one exact evidence packet in this child request');
    assert.equal(matches[0].index, messages.findIndex((message) => message.role === 'user'));
    const initial = JSON.parse(matches[0].text);
    const citations = context.candidate.statements.flatMap((statement) => statement.citations);
    const owners = citations.map((ref) => {
      const sources = initial.sources.filter((source) => source.source_id === ref.source_id);
      assert.equal(sources.length, 1);
      const source = sources[0];
      assert.equal(ref.content_hash, source.content_hash);
      assert.ok(Number.isInteger(ref.span.start) && Number.isInteger(ref.span.end) &&
        ref.span.start >= 0 && ref.span.end > ref.span.start && ref.span.end <= [...source.text].length);
      assert.equal([...source.text].slice(ref.span.start, ref.span.end).join(''), ref.quote);
      return source.user_id;
    });
    const expected = { evidence_packet_sha256: createHash('sha256').update(matches[0].text).digest('hex'),
      persisted_body: context.persisted_body, candidate: context.candidate,
      citation_roles: context.candidate.statements.flatMap((statement, statement_index) =>
        statement.citations.map((ref, citation_index) => ({ statement_index, citation_index,
          role: initial.sources.find((source) => source.source_id === ref.source_id).user_id === initial.current_user_id ? 'current' : 'prior' }))) };
    const witnessID = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
    assert.deepEqual(context, { ...expected, witness_id: witnessID });
    const currentOnly = owners.every((owner) => owner === initial.current_user_id);
    const hasPriorSources = initial.sources.some((source) => source.user_id !== initial.current_user_id);
    const result = { memory: { status: 'accept' },
      statements: context.candidate.statements.map((_, index) => ({ index, status: 'supported' })),
      continuity: hasPriorSources ? { status: currentOnly ? 'standalone' : 'supported', witness_id: witnessID } : { status: 'current' } };
    return JSON.stringify(change ? change(result, context) : current.reviewSupport ? current.reviewSupport(result, context) : result);
  } });
  return current;
}
async function generation(current, evidence) {
  const parent = await current.parent();
  const start = current.control.events.length;
  const http = current.provider.requests.length;
  const before = writes(current.control);
  current.provider.responses.push({ text: 'Confirmed.' }, current.extract(), current.commit(), { text: 'Fourth must not reach provider.' });
  await current.prompt(parent, 'For future responses, prefer concise Chinese for pipeline proof.');
  const review = await current.review(parent, start);
  assert.equal(meta(review).status, 'saved', JSON.stringify(meta(review)));
  const children = current.unwrap(await current.client.session.children({ path: { id: parent.id } }));
  assert.equal(children.length, 2);
  const extract = children.find((entry) => entry.title.endsWith('extract'));
  const commit = children.find((entry) => entry.title.endsWith('commit'));
  await current.control.wait((event) => event.phase === 'generation.blocked' && event.sessionID === commit.id && event.code === 'model_budget');
  const events = current.control.events.slice(start);
  assert.equal(events.filter((event) => event.phase === 'generation' && event.sessionID === extract.id).length, 2);
  assert.equal(events.filter((event) => event.phase === 'generation' && event.sessionID === commit.id).length, 1);
  assert.equal(current.provider.requests.length - http, 4);
  assert.equal(current.provider.responses.length, 1);
  assert.deepEqual(current.provider.requests[http + 1].body.tools ?? [], []);
  assert.deepEqual(current.provider.requests[http + 2].body.tools ?? [], []);
  assert.equal(writes(current.control) - before, 1);
  assert.equal(events.filter((event) => event.phase === 'native.ask').length, 1);
  const receipt = events.find((event) => event.phase === 'remember.result').receipt;
  assert.equal(receipt.readback.status, 'ok');
  assert.equal(meta(review).model_calls, 3);
  assert.equal(meta(review).write_attempts, 1);
  const saved = receipt.readback.results[0].memory;
  const read = await current.cli(['read', String(saved.id), '--placement', saved.placement]);
  assert.equal(read.results[0].memory.content, saved.content);
  evidence.cases.push({ name: 'synthesis_support_commit_native_readback_block_fourth', children, review: meta(review),
    parent_http: 1, extraction_http: 2, commit_http: 1, native_ask: 1, native_write: 1, readback: read });
  current.provider.responses.length = 0;
}
module.exports = { pipeline, generation, citation, packet, meta, writes };
