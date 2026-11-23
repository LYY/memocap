const assert = require('node:assert/strict');
const path = require('node:path');
const { write } = require('../setup-package-lifecycle-fixture.cjs');
const { userText } = require('./harness.cjs');

async function acquisition(current, evidence) {
  const route = '# Alpha route\n\nStart at docs/alpha.md. Approval required. Never use for beta.';
  const oversized = path.join(current.fixture.project, 'docs/oversized.md');
  const routePath = path.join(current.fixture.project, 'docs/route.md');
  write(oversized, `# Oversized\n${'bounded-output-fixture '.repeat(30)}\n`.repeat(600));
  write(routePath, route);
  for (const count of [32, 128]) {
    const parent = await current.parent();
    const rowStart = current.control.events.length;
    let lastStart;
    let lastRequests;
    for (let turn = 1; turn <= count; turn++) {
      lastStart = current.control.events.length;
      lastRequests = current.provider.requests.length;
      if (turn === count) current.provider.responses.push({ tool: 'read', args: { filePath: oversized } },
        { tool: 'read', args: { filePath: routePath } });
      current.provider.responses.push({ text: 'No durable decision.' }, { text: '{"candidates":[]}' });
      await current.prompt(parent, turn === count ? 'Locate the alpha route in docs/route.md after reading docs/oversized.md.' : `Synthetic completed turn ${turn}; temporary task only.`);
      const review = await current.review(parent, lastStart);
      assert.equal(review.payload.detail.metadata.reason, 'no_candidate', `turn ${turn}/${count} ${JSON.stringify(review)}`);
      if (turn % 32 === 0) process.stderr.write(`WORKING ${evidence.mode} ${count}-turn session completed ${turn}\n`);
    }
    const events = current.control.events.slice(lastStart);
    const sdk = events.filter((event) => event.phase === 'capture.sdk');
    const parentReads = sdk.filter((event) => event.method === 'session.messages' && event.request.path.id === parent.id);
    const extraction = current.provider.requests.slice(lastRequests).map((request) => {
      try { return JSON.parse(userText(request)); }
      catch (error) { if (error instanceof SyntaxError) return null; throw error; }
    }).find((packet) => packet?.evidence);
    assert.ok(extraction.evidence.some((unit) => unit.text.includes('docs/alpha.md')));
    const snapshots = events.filter((event) => event.phase === 'spike.snapshot');
    const record = { completed_turns: count, session_id: parent.id, capture_sdk: sdk,
      parent_history_reads: parentReads.map((event) => ({ request: event.request, returned: event.response.data.length,
        bytes: event.response_bytes })), child_input_bytes: Buffer.byteLength(JSON.stringify(extraction)),
      child_input: extraction, snapshot: snapshots.at(-1), ordinary_parent_context_traffic_included: false };
    if (evidence.mode === 'negative_control_0.6.0') {
      assert.ok(parentReads[0].response.data.length >= count * 2);
      assert.throws(() => assert.equal(parentReads.length, 0), { code: 'ERR_ASSERTION' });
      record.contract_result = 'RED_full_history_not_bounded';
      record.expected_assertion_failure = { actual: parentReads.length, expected: 0, operator: 'strictEqual' };
    } else {
      assert.equal(parentReads.length, 0);
      if (evidence.mode === 'production') {
        const retention = current.control.events.slice(rowStart).filter((event) => event.phase === 'capture.retention');
        assert.ok(retention.length > 0, 'production cache must report actual retention');
        const maxima = Object.fromEntries(Object.keys(retention[0].retained.maxima).map((key) =>
          [key, Math.max(...retention.map((event) => event.retained[key]))]));
        for (const measured of retention) {
          assert.ok(measured.retained.bytes <= evidence.profile.globalBytes);
          assert.ok(measured.retained.sessions <= evidence.profile.sessions);
          assert.ok(measured.retained.sessionTurns <= evidence.profile.turns);
          assert.ok(measured.retained.turnMessages <= evidence.profile.messages);
          assert.ok(measured.retained.messageParts <= evidence.profile.parts);
          assert.ok(measured.retained.turnBytes <= evidence.profile.turnBytes);
          assert.ok(measured.retained.partBytes <= evidence.profile.partBytes);
        }
        assert.ok(maxima.evidenceParts > 0);
        record.retention = { samples: retention.length, last: retention.at(-1).retained, row_maxima: maxima };
        record.acquisition_history = { requests: parentReads.length, returned_messages: 0, returned_bytes: 0 };
        const rowSDK = current.control.events.slice(rowStart).filter((event) => event.phase === 'capture.sdk');
        record.sdk_totals = { requests: rowSDK.length, request_bytes: rowSDK.reduce((sum, event) => sum + event.request_bytes, 0),
          returned_count: rowSDK.reduce((sum, event) => sum + event.returned_count, 0),
          response_bytes: rowSDK.reduce((sum, event) => sum + event.response_bytes, 0),
          semantics: 'All capture-only SDK methods in this row, including child creation/prompt and parent metadata. Parent session.messages remains separately zero.' };
        const assistant = events.findLast((event) => event.phase === 'host.event' && event.event.type === 'message.updated' &&
          event.event.properties.info.sessionID === parent.id && event.event.properties.info.finish === 'stop').event.properties.info;
        assert.ok(assistant.time.completed);
        const messages = new Set([assistant.parentID, ...events.filter((event) => event.phase === 'host.event' && event.event.type === 'message.updated' &&
          event.event.properties.info.parentID === assistant.parentID).map((event) => event.event.properties.info.id)]);
        const direct = events.filter((event) => event.phase === 'host.event' && event.event.type === 'message.part.updated' &&
          messages.has(event.event.properties.part.messageID)).map((event) => event.event.properties.part.id);
        assert.ok(extraction.evidence.every((unit) => direct.some((id) => unit.sourceId === id || unit.sourceId.startsWith(`${id}/section:`))));
        record.contract_result = 'GREEN_product_observed_only';
        record.completion_from_host = assistant;
        evidence.cases.push(record);
        continue;
      }
      assert.ok(snapshots.length > 0);
      const snapshot = snapshots.at(-1);
      assert.ok(snapshot.dropped > 0);
      assert.ok(snapshot.maxima.bytes <= snapshot.profile.globalBytes);
      assert.ok(snapshot.retained.turns <= snapshot.profile.turns * snapshot.profile.sessions);
      assert.ok(snapshot.bytes <= snapshot.profile.turnBytes);
      assert.ok(snapshot.messages.every((message) => message.info.id === snapshot.userID || message.info.parentID === snapshot.userID));
      const assistant = snapshot.messages.at(-1).info;
      assert.equal(assistant.finish, 'stop');
      assert.ok(assistant.time.completed);
      record.contract_result = 'GREEN_observed_only_bounded';
      record.completion_from_host = assistant;
    }
    evidence.cases.push(record);
  }
}
module.exports = { acquisition };
