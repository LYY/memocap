const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isolatedEnvironment } = require('./packaged-runtime.cjs');
const { startHost, portClosed } = require('./opencode-v1/host.cjs');

async function fixture(context, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memocap-request-budget-'));
  const eventsFile = path.join(root, 'requests.jsonl');
  fs.writeFileSync(path.join(root, 'opencode.json'), '{}');
  fs.writeFileSync(path.join(root, 'serve'), `
    const fs = require('node:fs');
    const http = require('node:http');
    const port = Number(process.argv.find(arg => arg.startsWith('--port=')).split('=')[1]);
    const server = http.createServer((request, response) => {
      fs.appendFileSync(process.env.BUDGET_EVENTS, JSON.stringify({ method: request.method, route: request.url }) + '\\n');
      request.resume();
      if (request.url === '/instance/dispose' && process.env.BUDGET_MODE !== 'dispose_hang') {
        response.end('{}'); return;
      }
      if (process.env.BUDGET_MODE === 'body_hang') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"pending":'); return;
      }
      if (process.env.BUDGET_MODE !== 'delayed') return;
      const timer = setTimeout(() => response.end(JSON.stringify({ method: request.method, route: request.url })), 500);
      response.once('close', () => clearTimeout(timer));
    });
    server.listen(port, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + port));
  `);
  const evidence = { cleanup: {} };
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, 'timeout', (milliseconds) => timeout(milliseconds / 100));
  let host;
  context.after(async () => {
    try {
      if (host) await host.close();
    } finally {
      if (evidence.host?.pid) {
        try { process.kill(evidence.host.pid, 'SIGKILL'); }
        catch (error) { assert.equal(error.code, 'ESRCH'); }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
    assert.equal(await portClosed(evidence.host.url), true);
    assert.throws(() => process.kill(evidence.host.pid, 0), { code: 'ESRCH' });
    assert.equal(fs.existsSync(root), false);
    context.diagnostic(JSON.stringify({ mode, requests: evidence.api_requests,
      cleanup: { pid_closed: true, port_closed: true, temp_removed: true } }));
  });
  host = await startHost({ host: process.execPath, config: path.join(root, 'opencode.json'),
    env: { ...isolatedEnvironment(root), BUDGET_EVENTS: eventsFile, BUDGET_MODE: mode },
    directories: { outside: root } }, { url: 'http://127.0.0.1:1/v1' }, evidence);
  return { host, evidence, requests: () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse) };
}

for (const operation of ['message', 'command', 'summarize']) {
  test(`actual host API completes delayed POST ${operation} with the operation budget`, async (context) => {
    const { host, evidence, requests } = await fixture(context, 'delayed');
    const route = `/session/session_123/${operation}`;

    const completed = await host.api(route, {});

    assert.deepEqual(completed, { method: 'POST', route });
    assert.deepEqual(requests(), [{ method: 'POST', route }]);
    assert.equal(evidence.api_requests[0].method, 'POST');
    assert.equal(evidence.api_requests[0].budget_ms, 180000);
    assert.equal(evidence.api_requests[0].stage, 'response');
    assert.equal(evidence.api_requests[0].status, 'completed');
  });
}

for (const [method, route] of [
  ['GET', '/session/session_123/message'], ['GET', '/session/session_123/command'],
  ['GET', '/session/session_123/summarize'], ['GET', '/command'],
  ['POST', '/ordinary'], ['POST', '/session'], ['POST', '/instance/dispose'],
  ['POST', '/prefix/session/session_123/message'], ['POST', '/session/session_123/message_async'],
  ['POST', '/session/session_123/message/suffix'], ['POST', '/session/session_123/command/'],
  ['POST', '/session//summarize'],
]) {
  test(`actual host API keeps the ordinary budget for ${method} ${route}`, async (context) => {
    const { host, evidence, requests } = await fixture(context, 'dispose_hang');

    await assert.rejects(host.api(route, method === 'POST' ? {} : undefined), /timeout|aborted/i);

    assert.deepEqual(requests(), [{ method, route }]);
    assert.equal(evidence.api_requests[0].method, method);
    assert.equal(evidence.api_requests[0].budget_ms, 25000);
    assert.equal(evidence.api_requests[0].aborted, true);
    assert.equal(evidence.api_requests[0].abort_phase, 'fetch');
    assert.equal(evidence.api_requests[0].status, 'failed');
  });
}

for (const mode of ['headers_hang', 'body_hang']) {
  test(`actual host API cancels one synchronous POST during ${mode}`, async (context) => {
    const { host, evidence, requests } = await fixture(context, mode);
    const route = '/session/session_123/message';

    await assert.rejects(host.api(route, {}), /timeout|aborted/i);

    assert.deepEqual(requests(), [{ method: 'POST', route }]);
    const request = evidence.api_requests[0];
    assert.equal(request.budget_ms, 180000);
    assert.equal(request.aborted, true);
    assert.equal(request.abort_phase, mode === 'headers_hang' ? 'fetch' : 'body_read');
    assert.equal(request.status, 'failed');
    assert.ok(Number.isFinite(request.elapsed_ms));
  });
}
