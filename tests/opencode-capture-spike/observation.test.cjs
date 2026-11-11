const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { lifecycleFixture } = require('../setup-package-lifecycle-fixture.cjs');
const { write } = require('../packaged-runtime.cjs');
const { repo, wireProvider, startHost, portClosed } = require('../opencode-v1/host.cjs');
const { controlServer } = require('./control.cjs');

test('real idle-parent abort and new input are observed while registered workers await a gate',
  { skip: process.env.MEMOCAP_CAPTURE_OBSERVATION !== '1', timeout: 180000 }, async (t) => {
    const evidence = { commands: [], assertions: [], cleanup: {}, paid_provider_requests: 0 };
    const fixture = lifecycleFixture(repo, evidence);
    let control;
    let provider;
    let host;
    try {
      const prepared = await fixture.prepare();
      control = await controlServer();
      control.settings.gate = true;
      const config = path.join(fixture.env.XDG_CONFIG_HOME, 'opencode/opencode.json');
      write(config, JSON.stringify({ plugin: [[pathToFileURL(path.join(__dirname, 'observer.mjs')).href,
        { control: control.url, observe: true }]] }));
      provider = await wireProvider();
      const executable = '/opt/homebrew/bin/opencode';
      evidence.actual_version = (await fixture.command(executable, ['--version'])).stdout.trim();
      assert.equal(evidence.actual_version, '1.19.5');
      host = await startHost({ env: fixture.env, config, host: executable,
        directories: { outside: fixture.project } }, provider, evidence);
      const sdkRoot = path.resolve(prepared.runnerRoot, '../../@opencode-ai/sdk');
      const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
      evidence.sdk = sdkPackage.version;
      const { createOpencodeClient } = await import(pathToFileURL(path.join(sdkRoot, sdkPackage.exports['.'].import)));
      const client = createOpencodeClient({ baseUrl: evidence.host.url, directory: fixture.project,
        fetch: (request) => fetch(request, { signal: AbortSignal.timeout(20000) }) });
      const unwrap = (result) => {
        assert.equal(result.error, undefined, JSON.stringify(result.error));
        return result.data;
      };
      const model = { providerID: 'wire', modelID: 'wire-model' };
      const toolsOff = Object.fromEntries((await host.api('/experimental/tool/ids')).map((name) => [name, false]));
      const prompt = (id) => client.session.prompt({ path: { id }, body: {
        model, tools: toolsOff, parts: [{ type: 'text', text: 'Complete a synthetic event observation.' }],
      } });
      const parentTrace = (id, start) => control.events.slice(start).filter((entry) =>
        entry.phase === 'host.event' && (entry.event.properties.sessionID === id ||
          entry.event.properties.info?.sessionID === id || entry.event.properties.part?.sessionID === id));

      const parent = unwrap(await client.session.create({ body: { title: 'Idle abort observation',
        permission: [{ permission: '*', pattern: '*', action: 'deny' }] } }));
      const first = unwrap(await prompt(parent.id));
      const created = await control.wait((entry) => entry.phase === 'worker.created' && entry.parentID === parent.id);
      await control.wait((entry) => entry.phase === 'gate.waiting' && entry.sessionID === created.sessionID);
      const before = unwrap(await client.session.messages({ path: { id: parent.id } }));
      assert.equal(first.info.finish, 'stop');
      assert.equal(first.info.parentID, created.userID);
      const offset = control.events.length;
      const aborted = unwrap(await client.session.abort({ path: { id: parent.id } }));
      const after = unwrap(await client.session.messages({ path: { id: parent.id } }));
      assert.deepEqual(after, before, 'idle abort does not change the completed turn');
      control.release(created.sessionID);
      const released = await control.wait((entry) => entry.phase === 'worker.released' && entry.sessionID === created.sessionID);
      assert.equal(released.latestUserID, created.userID);
      assert.equal(released.currentEpoch, released.epoch);
      evidence.idle_abort = { api_result: aborted, parentID: parent.id, workerID: created.sessionID,
        released, messages_unchanged: true, trace_until_worker_released: parentTrace(parent.id, offset) };
      t.diagnostic(`idle abort signals: ${JSON.stringify(evidence.idle_abort.trace_until_worker_released.map((entry) => entry.event))}`);
      assert.equal(provider.requests.length, 1, 'gated worker never prompted or wrote');

      const newer = unwrap(await client.session.create({ body: { title: 'New input observation',
        permission: [{ permission: '*', pattern: '*', action: 'deny' }] } }));
      unwrap(await prompt(newer.id));
      const oldWorker = await control.wait((entry) => entry.phase === 'worker.created' && entry.parentID === newer.id);
      await control.wait((entry) => entry.phase === 'gate.waiting' && entry.sessionID === oldWorker.sessionID);
      const newOffset = control.events.length;
      const next = unwrap(await prompt(newer.id));
      assert.notEqual(next.info.parentID, oldWorker.userID);
      const input = await control.wait((entry) => entry.phase === 'input.observed' && entry.userID === next.info.parentID);
      control.release(oldWorker.sessionID);
      const stale = await control.wait((entry) => entry.phase === 'worker.released' && entry.sessionID === oldWorker.sessionID);
      assert.equal(stale.latestUserID, next.info.parentID);
      assert.ok(stale.currentEpoch > stale.epoch);
      const newWorker = await control.wait((entry) => entry.phase === 'worker.created' &&
        entry.parentID === newer.id && entry.userID === next.info.parentID);
      await control.wait((entry) => entry.phase === 'gate.waiting' && entry.sessionID === newWorker.sessionID);
      control.release(newWorker.sessionID);
      await control.wait((entry) => entry.phase === 'worker.released' && entry.sessionID === newWorker.sessionID);
      evidence.new_input = { input, stale, trace_until_worker_released: parentTrace(newer.id, newOffset) };
      assert.equal(provider.requests.length, 3);

      const failed = unwrap(await client.session.create({ body: { title: 'Invalid model observation' } }));
      const failure = await client.session.prompt({ path: { id: failed.id }, body: {
        model: { providerID: 'wire', modelID: 'missing-model' }, tools: toolsOff,
        parts: [{ type: 'text', text: 'Synthetic invalid model request.' }],
      } });
      const failureEvent = await control.wait((entry) => entry.phase === 'host.event' &&
        entry.event.type === 'session.error' && entry.event.properties.sessionID === failed.id);
      const failureMessages = unwrap(await client.session.messages({ path: { id: failed.id } }));
      assert.equal(failureMessages.some((entry) => entry.info.role === 'assistant' &&
        entry.info.finish === 'stop' && entry.info.time.completed && !entry.info.error), false);
      assert.equal(control.events.some((entry) => entry.phase === 'worker.created' && entry.parentID === failed.id), false);
      evidence.failed_parent = { sdk_error: failure.error, reply: failure.data, failureEvent,
        messages: failureMessages, bound: 'through error response and subsequent session.messages read' };
      assert.equal(provider.requests.length, 3);
      assert.deepEqual(provider.errors, []);
      assert.equal(control.events.some((entry) => entry.phase === 'failed'), false, JSON.stringify(control.events));
      evidence.status = 'passed';
    } catch (error) {
      evidence.status = 'failed';
      evidence.error = error.stack;
      throw error;
    } finally {
      if (control) control.releaseAll();
      if (host) await host.close();
      if (evidence.host?.url) evidence.cleanup.host_port_closed = await portClosed(evidence.host.url);
      if (provider) {
        evidence.request_count = provider.requests.length;
        await provider.close();
        evidence.cleanup.provider_port_closed = await portClosed(provider.url);
      }
      if (control) { evidence.events = control.events; await control.close(); }
      evidence.cleanup.package = await fixture.cleanup();
      if (process.env.MEMOCAP_CAPTURE_EVIDENCE) fs.writeFileSync(process.env.MEMOCAP_CAPTURE_EVIDENCE,
        JSON.stringify(evidence, null, 2));
      t.diagnostic(JSON.stringify({ status: evidence.status, version: evidence.actual_version,
        request_count: evidence.request_count, cleanup: evidence.cleanup, error: evidence.error }));
    }
  });
