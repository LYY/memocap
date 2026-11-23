const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness } = require('./capture-pipeline-host/harness.cjs');
const { packet, meta, pipeline } = require('./capture-pipeline-host/helpers.cjs');
const { turns, custody, digest, propose } = require('./capture-support-input-fixture.cjs');

async function run(destination, phase) {
  const evidence = { mode: 'production', entry: 'capture_only', cleanup: {}, commands: [], rounds: [], packets: [] };
  const current = pipeline(await harness(evidence, path.join(destination, `capture-support-input-host-${phase}`)));
  let turnIndex = 0;
  try {
    const parent = await current.parent();
    const support = { get text() {
      const context = packet(current);
      evidence.packets.push({ kind: 'support', bytes: Buffer.byteLength(JSON.stringify(context)), sha256: digest(JSON.stringify(context)) });
      const messages = current.provider.requests.at(-1).body.messages;
      const prior = messages.filter((message) => message.role === 'user').map((message) => {
        const text = typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
        try { return { text, packet: JSON.parse(text) }; } catch (error) { if (!(error instanceof SyntaxError)) throw error; return undefined; }
      }).find((entry) => entry && digest(entry.text) === context.evidence_packet_sha256);
      assert.ok(prior, 'actual support provider window must retain the frozen evidence packet');
      assert.equal(prior.packet.sources.length, 6);
      for (const turn of turns) {
        const source = prior.packet.sources.find((entry) => entry.content_hash === turn.hash);
        assert.equal(source.text, turn.text);
        assert.deepEqual(source.span, { start: 0, end: [...turn.text].length });
        assert.ok(prior.packet.bundles.some((bundle) => bundle.units.some((unit) => unit.text === turn.text)));
      }
      assert.ok(messages.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('candidates')));
       assert.deepEqual(Object.keys(context).sort(), ['candidate', 'citation_roles', 'evidence_packet_sha256', 'persisted_body', 'witness_id']);
      evidence.retained_evidence = { sources: 6, bundles: prior.packet.bundles.length,
        constraints: prior.packet.constraints.length, original_packet_in_actual_window: true, proposal_in_actual_window: true,
        all_original_source_text_hash_span_quote_and_conditions: true };
      const citations = context.candidate.statements.flatMap((statement) => statement.citations);
      for (const citation of citations) {
        const source = prior.packet.sources.find((entry) => entry.source_id === citation.source_id);
        assert.equal(citation.content_hash, source.content_hash);
        assert.equal(citation.quote, [...source.text].slice(citation.span.start, citation.span.end).join(''));
      }
      return current.support().text;
    } };
    const extract = { get text() {
      const context = packet(current);
      evidence.packets.push({ kind: 'initial', turn: turnIndex + 1,
        bytes: Buffer.byteLength(JSON.stringify(context)), sha256: digest(JSON.stringify(context)),
        sources: context.sources.length, bundles: context.bundles.length });
      for (const source of context.sources) assert.equal(digest(source.text), source.content_hash);
      if (turnIndex < 2) return '{"candidates":[]}';
      const proposal = JSON.stringify(propose(context));
      evidence.proposal_bytes = Buffer.byteLength(proposal);
      current.provider.responses.unshift(support, current.commit());
      return proposal;
    } };
    for (turnIndex = 0; turnIndex < turns.length; turnIndex++) {
      const turn = turns[turnIndex];
      assert.equal(digest(turn.text), turn.hash);
      const filename = path.join(current.fixture.project, `c2-source-${turnIndex + 1}.data`);
      fs.writeFileSync(filename, turn.text);
      const start = current.control.events.length;
      current.provider.responses.push({ tool: 'read', args: { filePath: filename } }, { text: 'Confirmed.' }, extract);
      await current.prompt(parent, turn.user);
      const review = await current.review(parent, start);
      const events = current.control.events.slice(start);
      const children = current.unwrap(await current.client.session.children({ path: { id: parent.id } }));
      const owned = new Set(children.map((child) => child.id));
      evidence.rounds.push({ turn: turnIndex + 1, review: meta(review), native: events.filter((event) =>
        event.phase === 'native.input.measured' && owned.has(event.sessionID)).map(({ kind, round, message_bytes, system_bytes, limit, sha256 }) =>
        ({ kind, round, message_bytes, system_bytes, limit, sha256 })),
      blocked: events.filter((event) => event.phase === 'input.blocked').map(({ kind, code }) => ({ kind, code })) });
      if (meta(review).status === 'saved') {
        const receipt = events.find((event) => event.phase === 'remember.result').receipt;
        const memory = receipt.readback.results[0].memory;
        const read = await current.cli(['read', String(memory.id), '--placement', memory.placement]);
        assert.equal(read.results[0].memory.content, memory.content);
        evidence.readback = { independent: true, body_cp: [...memory.content].length, sha256: digest(memory.content) };
        evidence.t3_children = children.length - 2;
        assert.equal(meta(review).model_calls, 3);
        assert.equal(meta(review).write_attempts, 1);
        assert.equal(evidence.t3_children, 2);
        assert.equal(memory.content, packet(current).content);
      }
      current.provider.responses.length = 0;
    }
    assert.deepEqual(current.provider.errors, []);
    evidence.status = evidence.rounds.at(-1).review.status === 'saved' ? 'GREEN' :
      evidence.rounds.at(-1).review.reason === 'input_budget' ? 'RED' : 'NOT_REPRODUCED';
    assert.equal(evidence.status, phase.includes('red') ? 'RED' : 'GREEN');
  } finally {
    evidence.host_errors = current.control.events.filter((event) => event.phase === 'host.event' && event.event.type === 'session.error').map((event) => event.event.properties.error);
    current.control.events.length = 0;
    current.provider.requests.length = 0;
    await current.close();
    const output = { status: evidence.status, phase, custody, host: { version: evidence.host.version, sha256: evidence.host.sha256 },
      sdk: evidence.sdk, packets: evidence.packets, proposal_bytes: evidence.proposal_bytes,
      rounds: evidence.rounds, readback: evidence.readback, retained_evidence: evidence.retained_evidence,
      t3_children: evidence.t3_children, cleanup: evidence.cleanup, host_errors: evidence.host_errors };
    fs.rmSync(path.join(destination, `capture-support-input-host-${phase}`), { recursive: true, force: true });
    output.cleanup.owned_scratch_removed = true;
    fs.writeFileSync(path.join(destination, `capture-support-input-host-${phase}.json`), JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output));
  }
}

run(path.resolve(process.argv[2]), process.argv[3] ?? 'green').catch((error) => { console.error(error); process.exitCode = 1; });
