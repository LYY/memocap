const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const path = require('node:path');
const { write } = require('../setup-package-lifecycle-fixture.cjs');
const { citation, meta, writes } = require('./helpers.cjs');

async function continuity(current, evidence) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ job: '42', environment: 'alpha', state: request.method === 'POST' ? 'queued' : 'completed', verified: request.method === 'GET' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/jobs/42`;
  const route = path.join(current.fixture.project, 'alpha-jobs.md');
  write(route, 'Alpha job 42 requires approval before submission. Never apply this route to beta.');
  const parent = current.unwrap(await current.client.session.create({ body: { title: 'Pipeline continuation', permission: [
    { permission: 'memocap_remember', pattern: '*', action: 'allow' }, { permission: 'bash', pattern: '*', action: 'allow' },
  ] } }));
  const before = writes(current.control);
  try {
    let start = current.control.events.length;
    current.provider.responses.push({ tool: 'read', args: { filePath: route } }, { text: 'Route available.' }, { text: '{"candidates":[]}' });
    await current.prompt(parent, `Find the alpha job 42 route in ${route}.`);
    const first = await current.review(parent, start);
    assert.equal(meta(first).reason, 'no_candidate');
    start = current.control.events.length;
    current.provider.responses.push({ tool: 'bash', args: { command: `curl --fail --silent -X POST '${endpoint}'`, description: 'Submit approved alpha job 42' } },
      { text: 'Job queued, awaiting independent verification.' }, { text: '{"candidates":[]}' });
    await current.prompt(parent, 'Approval is granted for the same alpha job 42. Submit it, but queued is not completed.');
    const second = await current.review(parent, start);
    assert.equal(meta(second).reason, 'no_candidate');
    assert.equal(writes(current.control), before);
    start = current.control.events.length;
    current.provider.responses.push({ tool: 'bash', args: { command: `curl --fail --silent '${endpoint}'`, description: 'GET independent alpha job 42 verification' } },
      { text: 'Independent verification complete.' }, current.extract((packet) => {
        const old = packet.sources.find((source) => source.kind === 'file_content');
        const fresh = packet.sources.find((source) => source.kind === 'command_result' && source.user_id === packet.current_user_id);
        assert.ok(old && fresh, JSON.stringify(packet));
        assert.notEqual(old.user_id, packet.current_user_id);
        assert.equal(JSON.parse(fresh.text).verified, true);
        return { candidates: [{ statements: [{ text: 'Alpha job 42 was independently verified completed; this route requires approval and excludes beta.',
          citations: [citation(old), citation(fresh)] }] }] };
      }), current.commit(), { text: 'Blocked fourth.' });
    await current.prompt(parent, 'Verify completion of the same approved alpha job 42 by GET; preserve its route restrictions.');
    const third = await current.review(parent, start);
    assert.equal(meta(third).status, 'saved', JSON.stringify(meta(third)));
    assert.equal(writes(current.control), before + 1);
    assert.deepEqual(requests, [{ method: 'POST', url: '/jobs/42' }, { method: 'GET', url: '/jobs/42' }]);
    evidence.cases.push({ name: 'T1_route_T2_queued_T3_GET_verified', reviews: [meta(first), meta(second), meta(third)], requests });
    current.provider.responses.length = 0;
    const repaired = current.unwrap(await current.client.session.create({ body: { title: 'Independent repair verification', permission: [
      { permission: 'memocap_remember', pattern: '*', action: 'allow' }, { permission: 'bash', pattern: '*', action: 'allow' },
    ] } }));
    start = current.control.events.length;
    current.provider.responses.push({ tool: 'read', args: { filePath: path.join(current.fixture.project, 'alpha-missing.md') } },
      { tool: 'bash', args: { command: `curl --fail --silent '${endpoint}'`, description: 'Independently verify alpha job 42 after failed read' } },
      { text: 'GET verification supersedes the failed route read.' }, current.extract((packet) => {
        assert.ok(packet.sources.some((source) => source.kind === 'tool_error'), JSON.stringify(packet));
        const verified = packet.sources.find((source) => source.kind === 'command_result');
        assert.equal(JSON.parse(verified.text).verified, true);
        return { candidates: [{ statements: [{ text: 'The verification GET for alpha job 42 returned completed with verified=true.', citations: [citation(verified)] }] }] };
      }), current.commit(), { text: 'Blocked fourth.' });
    await current.prompt(repaired, 'Read alpha-missing.md, then independently verify alpha job 42 by GET even if that read fails.');
    const repairedReview = await current.review(repaired, start);
    assert.equal(meta(repairedReview).status, 'saved', JSON.stringify(meta(repairedReview)));
    assert.equal(writes(current.control), before + 2);
    evidence.cases.push({ name: 'terminal_tool_failure_then_independent_GET_repair', review: meta(repairedReview) });
    current.provider.responses.length = 0;
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
module.exports = { continuity };
