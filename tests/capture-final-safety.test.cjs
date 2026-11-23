const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isolatedEnvironment, digest } = require('./packaged-runtime.cjs');
const { fixture } = require('./capture-pipeline-fixture.cjs');
const proof = require('./capture-final-safety/observations.cjs');

test('actual safety producer binds canonical source and runtime identities to acceptance records', () => {
  const canonical = require('./capture-quality-population-native/authorization.cjs').sources();
  const evidence = { source: proof.source(), lane: 'deterministic_challenges', safety_observations: [],
    selector_file: 'tests/capture-final-safety.test.cjs' };
  proof.record(evidence, 'recursion', { case_id: 'worker inputs and idle replays cannot recursively claim capture', denominator: 8, violations: 0 });
  const row = evidence.safety_observations[0];
  assert.equal(row.source_sha256, canonical.digest);
  assert.deepEqual(evidence.source.manifest, Object.fromEntries(canonical.entries));
  assert.equal(row.host_version, process.versions.node);
  assert.equal(row.host_sha256, digest(fs.readFileSync(process.execPath)));
  assert.equal(row.native_sha256, digest(fs.readFileSync(path.join(proof.repo, 'target/debug/memocap'))));
  assert.equal(row.selector_sha256, digest(fs.readFileSync(__filename)));
  assert.equal(row.result, 'satisfied');
  proof.record(evidence, 'recursion', { case_id: 'worker inputs and idle replays cannot recursively claim capture', denominator: 8, violations: 1 });
  assert.equal(evidence.safety_observations[1].result, 'violated');
});

test('worker inputs and idle replays cannot recursively claim capture', async () => {
  const evidence = { source: proof.source(), lane: 'deterministic_challenges', safety_observations: [],
    selector_file: 'tests/capture-final-safety.test.cjs', cases: [] };
  const { createLifecycle } = await import('../plugin/capture/lifecycle.js');
  const life = createLifecycle(() => assert.fail('finished workers must not be aborted'));
  const observe = (id, serial) => life.observe({ sessionID: id, agent: 'build' },
    { message: { role: 'user', id: `user-${serial}` }, parts: [{ type: 'text', text: 'Remember this recursively for future sessions.' }] });
  observe('parent', 0);
  const idle = (id) => ({ type: 'session.status', properties: { sessionID: id, status: { type: 'idle' } } });
  const turn = life.event(idle('parent'));
  for (const stage of ['extract', 'commit']) life.worker(stage, turn, stage);
  life.finish(turn);
  let attempts = 0;
  for (const id of turn.children) for (let index = 0; index < 4; index++) {
    observe(id, ++attempts);
    assert.equal(life.event(idle(id)), undefined);
  }
  assert.deepEqual([...life.parents.keys()], ['parent']);
  assert.ok([...life.workers.values()].every((worker) => worker.closed));
  evidence.cases.push({ case_id: 'worker inputs and idle replays cannot recursively claim capture', attempts,
    descendants: [...life.workers].map(([id, worker]) => ({ id, closed: worker.closed })), recursive_claims: 0 });
  proof.record(evidence, 'recursion', { ...evidence.cases[0], denominator: attempts, violations: 0 });
  fs.mkdirSync(proof.destination, { recursive: true });
  const directory = fs.mkdtempSync(path.join(proof.destination, 'final-safety-unit-recursion-'));
  proof.persist(directory, evidence);
});

test('all persisted capture activity excludes observed raw and marked secret sources', async (context) => {
  fs.mkdirSync(proof.destination, { recursive: true });
  const directory = fs.mkdtempSync(path.join(proof.destination, 'final-safety-unit-activity-'));
  const sandbox = fs.mkdtempSync(path.join(directory, 'isolated-'));
  const env = isolatedEnvironment(sandbox);
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const native = path.join(proof.repo, 'target/debug/memocap');
  const invoke = (args) => {
    const result = spawnSync(native, ['--json', ...args], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  invoke(['activity', 'prepare']);
  const evidence = { source: proof.source(), lane: 'deterministic_challenges', safety_observations: [],
    selector_file: 'tests/capture-final-safety.test.cjs', native: { sha256: digest(fs.readFileSync(native)) } };
  const boundary = [];
  const failures = [];
  let installed = false;
  const current = await fixture(context, { propose(packet) { boundary.push(packet); return { candidates: [] }; },
    async beforeIdle({ runtime }) {
      if (installed) return;
      installed = true;
      const original = runtime.request;
      runtime.request = async (state, args) => {
        try { invoke(args); } catch (error) { failures.push(error.message); }
        return original(state, args);
      };
    } });
  current.state('parent').targets = [{ repository_id: `repository:${'a'.repeat(64)}` }];
  await current.turn('raw', 'Inspect this synthetic output.', [{ kind: 'command', text: proof.raw }]);
  assert.deepEqual(failures, []);
  assert.ok(JSON.stringify(boundary).includes(proof.raw), 'raw output must enter extraction boundary');
  const before = current.calls.filter((call) => call.type === 'generation').length;
  await current.turn('secret', `Inspect marked synthetic secret password=${proof.secret}`, [{ kind: 'read', text: `password=${proof.secret}` }]);
  assert.equal(current.calls.filter((call) => call.type === 'generation').length, before);
  const persisted = proof.rows(env.MEMOCAP_DB);
  assert.equal(persisted.length, 2);
  assert.equal(current.reviews.at(-1).detail.metadata.reason, 'secret');
  const checked = proof.absence(persisted);
  assert.throws(() => proof.absence([...persisted, { event_json: proof.raw }]), assert.AssertionError);
  assert.throws(() => proof.absence([...persisted, { event_json: proof.secret }]), assert.AssertionError);
  Object.assign(evidence, { rows: persisted, checked, raw_boundary_packets: boundary.length,
    secret_source_attempts: 1, negative_controls_detected: 2 });
  proof.record(evidence, 'activity_leak', { case_id: 'all persisted capture activity excludes observed raw and marked secret sources',
    denominator: checked.comparisons, violations: 0 });
  proof.persist(directory, evidence);
});
