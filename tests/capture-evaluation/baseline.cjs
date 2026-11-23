const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const base = '905a066aa4e67e9932e0f2af135aaa1cf170ad37';
const root = path.resolve(__dirname, '../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (file) => fs.readFileSync(path.join(__dirname, file));
const tests = ['tests/capture-evidence.test.cjs', 'tests/capture-admission.test.cjs',
  'tests/capture-identity.test.cjs', 'tests/capture-lifecycle.test.cjs'];

function messagesFor(turns) {
  return turns.flatMap((turn, index) => {
    const userID = `u${index + 1}`;
    return [
      { info: { id: userID, role: 'user' }, parts: [{ id: `${userID}-text`, type: 'text', text: turn.user }] },
      { info: { id: `a${index + 1}`, role: 'assistant', parentID: userID, finish: 'stop', time: { completed: 1 } },
        parts: [...turn.tools.map((tool) => ({ id: tool.id, callID: `call-${tool.id}`, type: 'tool', tool: tool.tool,
          state: { status: tool.status ?? 'completed', output: tool.output, input: { filePath: tool.path } } })),
        ...(turn.assistant ? [{ id: 'assistant-claim', type: 'text', text: turn.assistant }] : [])] },
    ];
  });
}

async function replay(source, fixtures) {
  const load = (file) => import(pathToFileURL(path.join(source, 'plugin/capture', file)).href);
  const [{ complete, limits }, { evidenceFor, extractionUnits }, { admitCandidate }, { identify }] =
    await Promise.all(['contract.js', 'evidence.js', 'admission.js', 'identity.js'].map(load));
  const results = fixtures.capture.map((fixture) => {
    const messages = messagesFor(fixture.turns);
    const userID = `u${fixture.turns.length}`;
    const completed = complete(messages, userID);
    const evidence = evidenceFor(messages, userID);
    const screened = new Map([...evidence].filter(([sourceId, unit]) =>
      admitCandidate({ candidates: [{ evidence: [{ sourceId, quote: unit.text }] }] },
        { evidence, limits, existingBodies: [] }).reason?.code !== 'secret'));
    const selected = extractionUnits(screened);
    const admitted = completed ? admitCandidate(fixture.proposal, { evidence, limits, existingBodies: [] }) : null;
    const actual = admitted?.reason?.code ?? admitted?.status ?? 'incomplete_turn';
    assert.equal(completed, fixture.old.complete, fixture.id);
    assert.equal(actual, fixture.old.admission, fixture.id);
    const result = { id: fixture.id, family: fixture.family, gold: fixture.gold.action,
      observed: { complete: completed, collected_ids: [...evidence.keys()],
        selected_ids: selected.map((unit) => unit.sourceId), admission: actual },
      meaning: 'public module probe with scripted proposal; no model decision or persistent write' };
    if (admitted?.status === 'candidate') {
      const identity = identify(admitted.candidate.sources.map(({ sourceId }) => evidence.get(sourceId)), 'repository:synthetic');
      result.observed.body_code_points = Array.from(identity.body).length;
      result.observed.fingerprint = identity.fingerprint;
    }
    if (fixture.identity_claims) {
      const units = [evidence.get('s1')];
      const first = identify(units, 'repository:synthetic');
      const second = identify(units.map((unit) => ({ ...unit, pointer: 'tool:later-review/call-same-source' })), 'repository:synthetic');
      assert.equal(first.key === second.key, fixture.old.source_identity_equal, fixture.id);
      result.observed.source_identity_equal = first.key === second.key;
      result.observed.identity_limitation = 'Both different intended claims map to the same full-source input; old identify has no approved-statement argument.';
    }
    return result;
  });
  return { limits, results };
}

async function main() {
  assert.ok(process.argv[2], 'Usage: node tests/capture-evaluation/baseline.cjs .omo/evidence/capture-expansion/baseline.json');
  const output = path.resolve(root, process.argv[2]);
  assert.ok(output.startsWith(path.join(root, '.omo/evidence/capture-expansion/baseline')), 'Output must be a baseline artifact in the delegated evidence directory');
  assert.equal(fs.existsSync(output), false, 'Baseline receipts are append-only: choose a new baseline-* name for replay');
  const manifest = JSON.parse(read('manifest.json'));
  const fixtureHashes = Object.fromEntries(Object.keys(manifest.files).map((file) => [file, sha(read(file))]));
  assert.deepEqual(fixtureHashes, manifest.files, 'Frozen dataset drift');
  const tuning = JSON.parse(read('tuning.json'));
  const holdout = JSON.parse(read('holdout.json'));
  for (const key of ['source_templates', 'task_templates']) {
    assert.deepEqual(tuning[key].filter((template) => holdout[key].includes(template)), [], key);
  }
  const git = (args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_MASTER: '1' } });
  assert.equal(git(['rev-parse', 'v0.6.0^{commit}']).toString().trim(), base);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const archive = git(['archive', '--format=tar', base, 'plugin/capture', ...tests, 'package.json', 'package-lock.json']);
  const source = fs.mkdtempSync(path.join(path.dirname(output), 'baseline-source-'));
  const report = {
    schema: 1, status: 'running', created_at: new Date().toISOString(),
    code: { tag: 'v0.6.0', sha: base, archive_sha256: sha(archive), origin: 'git archive of exact commit, never current worktree modules' },
    runtime: { node: process.version, executable: process.execPath, node_sha256: sha(fs.readFileSync(process.execPath)), platform: process.platform, arch: process.arch },
    fixture_hashes: fixtureHashes, fixture_set_sha256: sha(JSON.stringify(fixtureHashes)),
    runner_sha256: sha(fs.readFileSync(__filename)), holdout: { status: 'not_evaluated', metadata_and_hash_only: true },
    budgets: { children: 2, model_calls: 3, write_attempts: 1, timeout_ms: 30000, input_units: 12, cited_units: 2, quote_code_points: 800, body_code_points: 1200 },
    traffic: { model_requests: 0, business_requests: 0, database_accesses: 0 },
    cleanup: {},
  };
  try {
    execFileSync('tar', ['-xf', '-', '-C', source], { input: archive });
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
    report.code.package_version = pkg.version;
    report.code.plugin_version = pkg.version;
    report.code.plugin_sdk_version = pkg.dependencies['@opencode-ai/plugin'];
    report.code.module_hashes = Object.fromEntries(['contract.js', 'evidence.js', 'read-source.js', 'admission.js', 'identity.js'].map((file) =>
      [file, sha(fs.readFileSync(path.join(source, 'plugin/capture', file)))]));
    report.code.package_lock_sha256 = sha(fs.readFileSync(path.join(source, 'package-lock.json')));
    report.code.binary = { status: 'not_run', version: null, sha256: null,
      reason: 'This immutable source replay does not build or execute the native CLI; no arbitrary installed binary is labeled v0.6.0.' };
    process.stderr.write('WORKING: running unchanged v0.6.0 targeted contracts from immutable archive\n');
    const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: source, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, MEMOCAP_CAPTURE_E2E: '0', MEMOCAP_CAPTURE_QUALITY: '0' } });
    assert.ifError(result.error);
    const log = `${output.slice(0, -5)}-tests.tap`;
    fs.writeFileSync(log, result.stdout + result.stderr, { flag: 'wx' });
    report.tests = { command: `node --test ${tests.join(' ')}`, cwd: 'immutable archive', exit_code: result.status,
      log: path.relative(root, log), log_sha256: sha(fs.readFileSync(log)) };
    assert.equal(result.status, 0, 'Unchanged baseline tests failed');
    process.stderr.write('WORKING: replaying tuning module boundaries; holdout evaluation disabled\n');
    const replayed = await replay(source, tuning);
    report.module_limits = replayed.limits;
    report.capture = replayed.results;
    report.maintenance = tuning.maintenance.map((fixture) => ({ id: fixture.id, family: fixture.family,
      gold: fixture.gold.action, observed: 'not_implemented', mutations: null,
      reason: 'v0.6.0 has confirmed organization operations, not automatic post-use review; no simulated persistence result claimed' }));
    report.planned_denominators = { tuning: { capture: tuning.capture.length, maintenance: tuning.maintenance.length },
      holdout: { capture: holdout.capture.length, maintenance: holdout.maintenance.length } };
    report.measurement = { deterministic_old_contract: { matched: replayed.results.length, total: tuning.capture.length },
      hypothetical_new_capture_outcomes: 'not_run', semantic_quality: 'blocked_no_authorized_model',
      maintenance_quality: 'blocked_contract_and_model', host: 'not_run_in_this_lane',
      reasons: ['Module probes do not establish bounded host acquisition, permission, cancellation, write/readback or cleanup of host children.',
        'Scripted proposals and human-authored gold are not measured model precision, coverage, support or continuity.',
        'Native binary and two-version host evidence must be supplied separately before QA-0 can be marked complete.'] };
    report.status = 'module_baseline_recorded_qa0_partial';
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    report.cleanup = { immutable_archive_directory_removed: true, children_started: 0, servers_started: 0, sqlite_opened: false };
  }
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: report.status, artifact: path.relative(root, output), capture: report.capture.length,
    maintenance_planned: report.maintenance.length, unchanged_tests_exit: report.tests.exit_code })}\n`);
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
