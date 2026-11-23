const assert = require('node:assert/strict');
const { execFileSync, fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { text } = require('node:stream/consumers');

for (const { name, args, stdout = execFileSync(process.execPath, args, { encoding: 'utf8' }), version } of [
  { name: 'forwards and records the exact version', args: ['--version'], version: true },
  { name: 'forwards ordinary stdout without recording it', args: ['-p', '"fixture output"'], stdout: 'fixture output\n', version: false },
]) {
  test(`native probe ${name} when the child closes before spawn acknowledgment`, { timeout: 5000 }, async (context) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'maintenance-native-probe-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const events = [];
    const nativeClosed = Promise.withResolvers();
    const server = http.createServer(async (request, response) => {
      if (request.method === 'GET') return response.end('{}');
      const event = JSON.parse(await text(request));
      events.push(event);
      if (event.phase === 'native.spawn') await nativeClosed.promise;
      response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    context.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    await once(server, 'listening');
    const settings = path.join(root, 'probe.json');
    fs.writeFileSync(settings, JSON.stringify({ native: process.execPath, control: `http://127.0.0.1:${server.address().port}` }));

    // Observe the real child's close from inside the probe, after its stdio has closed.
    const observeClose = `import childProcess from 'node:child_process';
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  child.once('close', () => process.send('native-closed'));
  return child;
};`;
    const probe = fork(path.join(__dirname, 'maintenance-integration/native-probe.cjs'), args, {
      execArgv: ['--import', `data:text/javascript,${encodeURIComponent(observeClose)}`],
      env: { MAINTENANCE_PROBE_SETTINGS: settings },
      silent: true,
      signal: context.signal,
    });
    probe.once('message', nativeClosed.resolve);
    const result = Promise.all([once(probe, 'close'), text(probe.stdout), text(probe.stderr), nativeClosed.promise]);
    probe.stdin.end();

    const [exit, forwarded, stderr, closed] = await result;
    assert.equal(closed, 'native-closed');
    assert.deepEqual(exit, [0, null], stderr);
    assert.deepEqual({ stdout: forwarded, phases: events.map(({ phase }) => phase) }, {
      stdout, phases: ['native.spawn', 'native.finished'],
    });
    assert.deepEqual(events[1], {
      phase: 'native.finished', args, code: 0, signal: null, stderr: '', ...(version ? { stdout } : {}),
    });
  });
}
