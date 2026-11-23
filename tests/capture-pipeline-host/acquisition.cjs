const assert = require('node:assert/strict');
const path = require('node:path');
const { write } = require('../setup-package-lifecycle-fixture.cjs');
const { userText } = require('../capture-expansion-spike/harness.cjs');
const { meta } = require('./helpers.cjs');

async function acquisition(current, evidence) {
  evidence.profile = { turns: 8, sessions: 4, messages: 16, parts: 24, partBytes: 8192, turnBytes: 32768, globalBytes: 131072, ttlMs: 120000 };
  const oversized = path.join(current.fixture.project, 'docs/pipeline-oversized.md');
  const routePath = path.join(current.fixture.project, 'docs/pipeline-route.md');
  write(oversized, `# Oversized\n${'bounded-output-fixture '.repeat(30)}\n`.repeat(600));
  write(routePath, '# Alpha route\n\nStart at docs/alpha.md. Approval required. Never use for beta.');
  for (const count of [32, 128]) {
    const parent = await current.parent();
    const rowStart = current.control.events.length;
    let lastRequests;
    for (let turn = 1; turn <= count; turn++) {
      const start = current.control.events.length;
      lastRequests = current.provider.requests.length;
      if (turn === count) current.provider.responses.push({ tool: 'read', args: { filePath: oversized } }, { tool: 'read', args: { filePath: routePath } });
      current.provider.responses.push({ text: 'No durable decision.' }, { text: '{"candidates":[]}' });
      await current.prompt(parent, turn === count ? `Locate alpha docs/alpha.md after reading ${oversized} and ${routePath}.` : `Temporary task ${turn}, no durable decision.`);
      const review = await current.review(parent, start);
      assert.equal(meta(review).reason, 'no_candidate', JSON.stringify(meta(review)));
      assert.equal(meta(review).model_calls, 1);
      if (turn % 32 === 0) process.stderr.write(`WORKING pipeline ${evidence.host.version}: ${turn}/${count} completed observed turns\n`);
    }
    const events = current.control.events.slice(rowStart);
    const sdk = events.filter((event) => event.phase === 'capture.sdk');
    assert.equal(sdk.filter((event) => event.method === 'session.messages' && event.request.path.id === parent.id).length, 0);
    const packet = current.provider.requests.slice(lastRequests).map((request) => {
      try { return JSON.parse(userText(request)); } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
    }).find((value) => value?.sources);
    assert.ok(packet.sources.some((source) => source.kind === 'file_content' && source.text.includes('Never use for beta.')));
    assert.ok(packet.bundles.flatMap((bundle) => bundle.units).length <= 12);
    assert.ok(Buffer.byteLength(JSON.stringify(packet.bundles)) <= 16384);
    assert.ok(new Set(packet.sources.map((source) => source.user_id)).size <= 8);
    const retention = events.filter((event) => event.phase === 'capture.retention').map((event) => event.retained);
    assert.ok(retention.length);
    for (const item of retention) {
      for (const [key, limit] of Object.entries({ bytes: 'globalBytes', sessions: 'sessions', sessionTurns: 'turns',
        turnMessages: 'messages', messageParts: 'parts', turnBytes: 'turnBytes', partBytes: 'partBytes' })) {
        assert.ok(item[key] <= evidence.profile[limit], `${key}: ${item[key]}`);
      }
    }
    const maxima = Object.fromEntries(Object.keys(retention[0].maxima).map((key) => [key, Math.max(...retention.map((item) => item[key]))]));
    evidence.cases.push({ name: 'bounded_observed_acquisition', completed_turns: count, parent_history_reads: 0,
      sdk: { requests: sdk.length, request_bytes: sdk.reduce((sum, item) => sum + item.request_bytes, 0), response_bytes: sdk.reduce((sum, item) => sum + item.response_bytes, 0) },
      retention_samples: retention.length, retention_maxima: maxima, selected_bytes: Buffer.byteLength(JSON.stringify(packet.bundles)),
      extraction_input_bytes: Buffer.byteLength(JSON.stringify(packet)), source_count: packet.sources.length });
  }
}
module.exports = { acquisition };
