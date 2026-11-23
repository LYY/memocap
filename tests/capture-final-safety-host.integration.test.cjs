const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { harness } = require('./capture-pipeline-host/harness.cjs');
const { pipeline, generation, meta, writes, packet } = require('./capture-pipeline-host/helpers.cjs');
const { maintenanceHost } = require('./maintenance-integration/host.cjs');
const { usedTask, revised } = require('./maintenance-integration/scenarios.cjs');
const proof = require('./capture-final-safety/observations.cjs');
const { finalize, selector } = require('./capture-final-safety/combined-fixture.cjs');

test(selector,
  { skip: process.env.MEMOCAP_CAPTURE_E2E !== '1', timeout: 240000 }, async (context) => {
  assert.equal(process.execPath, '/opt/homebrew/Cellar/node/26.13.1_2/bin/node');
  assert.ok(process.env.MEMOCAP_CAPTURE_HOST_EXECUTABLE !== undefined || ['0', '1'].includes(process.env.MEMOCAP_CAPTURE_PACKAGED_HOST));
  const directory = fs.mkdtempSync(path.join(proof.destination, 'final-safety-host-'));
  const binding = proof.source();
  const evidence = { mode: 'production', selector_file: 'tests/capture-final-safety-host.integration.test.cjs', source: binding,
    lane: 'native_real_host_challenges', safety_observations: [], cases: [], cleanup: {}, commands: [], status: 'working' };
  let current;
  let maintenance;
  let failure;
  const sessions = [];
  try {
    current = await harness(evidence, directory);
    pipeline(current);
    evidence.source = binding;
    assert.equal(evidence.sdk.version, '1.19.3');
    assert.equal(evidence.native.version, 'memocap 0.7.0');
    current.support = () => ({ get text() { return JSON.stringify({ memory: { status: 'accept' },
      statements: packet(current).candidate.statements.map((_, index) => ({ index, status: 'supported' })),
      continuity: { status: 'current' } }); } });
    await generation(current, evidence);
    const rootID = evidence.cases[0].children[0].parentID;
    const before = { requests: current.provider.requests.length, writes: writes(current.control), reviews:
      current.control.events.filter((event) => event.phase === 'capture.review').length };
    const initial = await proof.descendants(current, rootID);
    assert.equal(initial.length, 2);
    const attempts = [];
    for (const child of initial) for (let index = 0; index < 2; index++) {
      const result = await current.client.session.prompt({ path: { id: child.id }, signal: AbortSignal.timeout(15000),
        body: { model: current.model, agent: 'build', parts: [{ type: 'text', text: `For future work remember recursive challenge ${index}.` }] } });
      attempts.push({ child_id: child.id, index, error: result.error ?? result.data?.info?.error ?? null });
      await current.client.session.abort({ path: { id: child.id } });
    }
    const terminal = await proof.descendants(current, rootID);
    assert.deepEqual(terminal.map((entry) => entry.id).sort(), initial.map((entry) => entry.id).sort());
    assert.ok(terminal.every((entry) => entry.status === 'idle'));
    assert.equal(current.provider.requests.length, before.requests);
    assert.equal(writes(current.control), before.writes);
    assert.equal(current.control.events.filter((event) => event.phase === 'capture.review').length, before.reviews);
    const blocked = current.control.events.filter((event) => ['generation.blocked', 'input.blocked'].includes(event.phase) &&
      initial.some((child) => child.id === event.sessionID));
    assert.ok(blocked.length >= attempts.length);
    evidence.cases.push({ case_id: 'recursion', attempts, terminal_descendants: terminal, blocked_generations: blocked,
      recursion_provider_requests: current.provider.requests.length - before.requests, recursion_writes: writes(current.control) - before.writes });
    sessions.push(rootID);
    for (const mode of ['raw', 'secret', 'native-secret']) {
      const parent = await current.parent();
      sessions.push(parent.id);
      const start = current.control.events.length;
      const http = current.provider.requests.length;
      const filePath = path.join(current.fixture.project, `final-${mode}.txt`);
      fs.writeFileSync(filePath, mode === 'secret' ? `password=${proof.secret}` : proof.raw);
      if (mode === 'native-secret') current.control.settings.captureNativeInput = { surface: 'system', stage: 'extract', round: 1 };
      current.provider.responses.push({ tool: 'read', args: { filePath } }, { text: 'Synthetic source inspected.' }, { text: '{"candidates":[]}' });
      await current.prompt(parent, 'Inspect the isolated local fixture for future work.');
      const review = await current.review(parent, start);
      const requests = current.provider.requests.slice(http);
      const worker = requests.slice(2);
      if (mode === 'raw') assert.ok(JSON.stringify(worker).includes(proof.raw), 'raw read output must enter worker boundary');
      else {
        if (mode === 'secret') {
          assert.ok(JSON.stringify(requests[1]).includes(proof.secret), 'ordinary parent read must really see marked source');
        } else {
          assert.equal(worker.length, 0);
          assert.ok(current.control.events.slice(start).some((event) => event.phase === 'native.input.injected'));
        }
      }
      proof.absence(worker, [proof.secret, 'fixture-native-only']);
      evidence.cases.push({ case_id: `capture-${mode}`, parent_id: parent.id, request_start: http,
        parent_requests: 2, worker_requests: worker.length, review: meta(review) });
      current.provider.responses.length = 0;
      delete current.control.settings.captureNativeInput;
    }
    evidence.capture_activity = proof.rows(current.fixture.env.MEMOCAP_DB);
    evidence.capture_checked = proof.absence(evidence.capture_activity);
    assert.ok(evidence.capture_activity.some((row) => row.phase === 'capture_review'));
    const maintenanceEvidence = { cleanup: {}, commands: [] };
    evidence.maintenance = maintenanceEvidence;
    if (evidence.host.executable) {
      maintenance = await maintenanceHost(evidence.host.version, maintenanceEvidence, { selectedHost: evidence.host });
      assert.equal(maintenanceEvidence.host.executable, evidence.host.executable);
    } else {
      const priorBinary = process.env.MEMOCAP_MAINTENANCE_HOST_1193;
      process.env.MEMOCAP_MAINTENANCE_HOST_1193 = current.fixture.host;
      context.after(() => {
        if (priorBinary === undefined) delete process.env.MEMOCAP_MAINTENANCE_HOST_1193;
        else process.env.MEMOCAP_MAINTENANCE_HOST_1193 = priorBinary;
      });
      maintenance = await maintenanceHost(evidence.host.version, maintenanceEvidence);
    }
    assert.equal(maintenanceEvidence.native.version, '0.7.0');
    assert.equal(maintenanceEvidence.host.sha256, evidence.host.sha256);
    const parent = await maintenance.parent();
    const filePath = path.join(maintenance.root, 'project/final-source.txt');
    fs.writeFileSync(filePath, proof.raw);
    usedTask(maintenance, { observations: [{ tool: 'read', args: { filePath } }] });
    await maintenance.prompt(parent, revised);
    const review = await maintenance.control.wait((event) => event.phase === 'maintenance.review' && event.parentID === parent.id);
    assert.equal(review.status, 'committed');
    await maintenance.captureDone(parent);
    await maintenance.control.wait((event) => event.phase === 'native.finished' && event.args?.[0] === 'activity' &&
      event.args[1] === 'record' && JSON.parse(event.args[event.args.indexOf('--payload') + 1]).context.session_id === parent.id);
    const packets = maintenance.provider.requests.filter((request) => JSON.stringify(request).includes(proof.raw));
    assert.ok(packets.length > 1, 'raw output must cross parent and maintenance worker boundaries');
    evidence.maintenance_raw = { review, raw_boundary_requests: packets.length };
    const secretParent = await maintenance.parent();
    maintenance.control.settings.childSecret = 'system';
    maintenance.provider.responses.length = 0;
    maintenance.provider.responses.push({ tool: 'memocap_read', args: { id: 1, placement: 'universal' } },
      { tool: 'memocap_maintain', get args() {
        const receipt = maintenance.control.events.findLast((event) => event.phase === 'tool.result' && event.name === 'memocap_read').result.maintenance_read;
        return { operation: 'use', ...receipt, statements: ['route is now /v2'] };
      } }, { text: 'Updated record adopted for synthetic verification.' });
    const requestStart = maintenance.provider.requests.length;
    await maintenance.prompt(secretParent, revised);
    const secretReview = await maintenance.control.wait((event) => event.phase === 'maintenance.review' && event.parentID === secretParent.id);
    assert.equal(secretReview.reason, 'sensitive_input');
    const secretRequests = maintenance.provider.requests.slice(requestStart);
    assert.equal(secretRequests.length, 3);
    proof.absence(secretRequests, [proof.secret, 'fixture-only']);
    evidence.maintenance_secret = { review: secretReview, provider_requests: secretRequests.length,
      blocked_inputs: maintenance.control.events.filter((event) => event.phase === 'input.blocked'),
      injections: maintenance.control.events.filter((event) => event.phase === 'native.input.injected') };
    assert.ok(evidence.maintenance_secret.blocked_inputs.length > 0);
    assert.equal(evidence.maintenance_secret.injections.length, 1);
    await maintenance.captureDone(secretParent);
    await maintenance.control.wait((event) => event.phase === 'native.finished' && event.args?.[0] === 'activity' &&
      event.args[1] === 'record' && JSON.parse(event.args[event.args.indexOf('--payload') + 1]).context.session_id === secretParent.id);
    evidence.maintenance_activity = proof.rows(maintenance.database);
    evidence.maintenance_checked = proof.absence(evidence.maintenance_activity);
    assert.ok(evidence.maintenance_activity.some((row) => row.event_json.includes('maintain_update')));
    for (const id of [parent.id, secretParent.id]) {
      const descendants = await proof.descendants(maintenance, id);
      assert.ok(descendants.every((entry) => entry.status === 'idle'));
      evidence.cases.push({ case_id: 'maintenance-terminal', parent_id: id, descendants });
    }
    const lifecycle = maintenance.control.events.filter((event) => event.phase === 'session.lifecycle');
    evidence.maintenance_closed_descendants = lifecycle.filter((event) => event.method === 'create' &&
      event.title?.startsWith('memocap maintenance')).map((child) => {
      assert.ok(lifecycle.some((event) => event.method === 'delete' && event.id === child.id && event.deleted));
      return { ...child, status: 'closed' };
    });
    assert.equal(evidence.maintenance_closed_descendants.length, review.child_sessions + secretReview.child_sessions);
    evidence.terminal_sessions = [];
    for (const id of sessions) evidence.terminal_sessions.push({ parent_id: id, descendants: await proof.descendants(current, id) });
    assert.ok(evidence.terminal_sessions.every((entry) => entry.descendants.every((child) => child.status === 'idle')));
    assert.deepEqual(current.provider.errors, []);
    assert.deepEqual(maintenance.provider.errors, []);
    evidence.status = 'observed';
  } catch (error) { failure = error; }
  finally {
    await finalize(context, { directory, evidence, current, maintenance, failure });
  }
});
