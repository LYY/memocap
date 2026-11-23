const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createDispatcher } = require('./dispatcher.cjs');
const { mapping, tuning, resolveCase, payload } = require('./inputs.cjs');

const digest = (value) => createHash('sha256').update(value).digest('hex');
const hashObject = (value) => digest(JSON.stringify(value));
const root = path.resolve(__dirname, '../..');
const contractFile = path.join(root, 'tests/capture-evaluation/native-driver-contract.json');
const forbidden = new Set(['gold', 'old', 'proposal', 'identity_claims', 'expected_body',
  'id', 'family', 'source_template', 'task_template', 'caseID']);

function assertModelBoundary(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `Evaluator field leaked: ${key}`);
    assertModelBoundary(child);
  }
}

function exerciseCase(entry) {
  const dispatcher = createDispatcher(entry.id);
  const { original } = resolveCase(entry.id);
  const input = dispatcher.model.input();
  assertModelBoundary(input);
  if (original.turns) {
    assert.deepEqual(input.turns.map((turn) => turn.user), original.turns.map((turn) => turn.user));
    assert.deepEqual(input.turns.map((turn) => turn.assistant), original.turns.map((turn) => turn.assistant));
  } else {
    assert.deepEqual(input.primary.snapshot, original.record);
    assert.equal(input.primary.fixture_used, original.used);
    assert.deepEqual(input.comparisons.map((record) => record.snapshot), original.participants || []);
  }
  const executed = [];
  for (const [name, argument] of entry.script) {
    if (name === 'control') {
      assert.equal(dispatcher.control(argument).kind, 'control');
      continue;
    }
    const result = dispatcher.model.execute(name, argument);
    assert.equal(result.kind, 'response', `${entry.id}:${name} did not execute`);
    assertModelBoundary(result);
    const operation = entry.operations[name];
    if (operation.pointer) {
      const expected = payload(entry.id, operation.pointer);
      assert.deepEqual(result.value.output ?? result.value.observation, expected);
      if (operation.pointer.startsWith('/turns/')) {
        const { id: fixtureAlias, output, ...tool } = payload(entry.id, operation.pointer.slice(0, -7));
        assert.deepEqual(result.value.tool, tool);
      }
    }
    switch (operation.kind) {
      case 'approve': assert.equal(result.value.accepted, argument.count === 2); break;
      case 'verify': assert.equal(result.value.passed, true); break;
      case 'compare': assert.deepEqual(result.value.unique_facts, []); break;
      case 'conflict-probe': assert.deepEqual(result.value, { snapshot: 'conflict', applied: false, writes: 0 }); break;
      case 'readback': assert.equal(result.value.additional_writes, 0); break;
      default: break;
    }
    executed.push({ name, operation: operation.kind, pointer: operation.pointer || null,
      response_sha256: hashObject(result), original_bytes_equal: operation.pointer ? true : null });
  }
  const audit = dispatcher.audit();
  assert.equal(audit.native_adoptions + audit.native_writes + audit.secondary_uses + audit.natural_opportunities_added, 0);
  return {
    id: entry.id, pointer: entry.pointer, classification: entry.classification, stratum: entry.stratum,
    module_execution: 'passed', transport: 'fake-local-state-only', host: 'not_run', model: 'not_run',
    blocked: entry.blocked || [], original_case_sha256: hashObject(original),
    original_turns_or_observations_sha256: hashObject(original.turns || original.observations),
    original_gold: original.gold, expected_adjudication_only: true,
    frozen_opportunities: original.turns ? Number(original.gold.action === 'save')
      : Number(['verified-condition-update', 'verified-retirement'].includes(entry.id)),
    frozen_positive_claims: original.turns && original.gold.action === 'save' ? original.gold.claims.length : 0,
    operations: entry.operations, executed,
    test_control_events: entry.script.filter(([name]) => name === 'control').map(([, event]) => event),
    transcript_sha256: hashObject(audit.transcript),
  };
}

function runPopulation() {
  const contract = JSON.parse(readFileSync(contractFile, 'utf8'));
  const originals = [...tuning.capture, ...tuning.maintenance];
  assert.deepEqual(mapping.cases.map((entry) => entry.id), originals.map((original) => original.id));
  assert.equal(new Set(mapping.cases.map((entry) => entry.id)).size, 28);
  const inputHashes = {};
  for (const [file, expected] of Object.entries({ ...contract.preservation.frozen9, ...contract.preservation.reviewed_artifacts })) {
    const actual = digest(readFileSync(path.join(root, file)));
    const drift = mapping.observed_historical_drift[file];
    assert.equal(actual, drift ? drift.task_baseline_sha256 : expected, `Task baseline bytes changed: ${file}`);
    inputHashes[file] = { contract_expected: expected, task_baseline: drift ? drift.task_baseline_sha256 : expected,
      actual, task_unchanged: true, contract_match: actual === expected,
      observation: drift ? drift.reason : null, holdout_decoded: false };
  }
  const cases = mapping.cases.map(exerciseCase);
  assert.equal(cases.reduce((sum, item) => sum + item.frozen_positive_claims, 0), 9);
  assert.equal(cases.slice(0, 16).reduce((sum, item) => sum + item.frozen_opportunities, 0), 8);
  assert.equal(cases.slice(16).reduce((sum, item) => sum + item.frozen_opportunities, 0), 2);
  const implementationHashes = {};
  for (const file of ['mapping.json', 'inputs.cjs', 'dispatcher.cjs', 'dispatcher.test.cjs', 'driver.cjs', 'README.md']) {
    implementationHashes[file] = digest(readFileSync(path.join(__dirname, file)));
  }
  return {
    schema: 1, kind: 'offline_population_operationalization', status: 'module_verified_runtime_unrun',
    input_hashes: inputHashes, implementation_hashes: implementationHashes,
    contract_sha256: digest(readFileSync(contractFile)),
    frozen_denominators: contract.frozen_counts, cases,
    maintenance_request_mapping: mapping.maintenance_request,
    partial_carrier: mapping.partial_carrier, retirement_state_mapping: mapping.retirement_state,
    execution: { surface: 'real Node CommonJS module driver', cases_executed: cases.length,
      dispatcher_operations: cases.reduce((sum, item) => sum + item.executed.length, 0),
      transport: 'fake in-memory finite state', actual_host: 'not_run', actual_model: 'not_run',
      provider_requests: 0, network_calls: 0, database_operations: 0, native_writes: 0,
      host_permission_receipts: 0, native_adoption_receipts: 0, holdout_decoded: false, holdout_scored: false },
    quality: { status: 'not_run', numerator: null, denominator: null, qa7_complete: false },
    limitations: [
      'Transport equivalence only; no claim of exact historical host execution or native source/completion/permission IDs.',
      'All expected/gold/proposed candidate metadata stays outside model facade. No support model or semantic evaluator runs.',
      'Maintenance root request is adapter-added operationalization, never original user text. Fixture use flags prove no native adoption.',
      'Partial-read offset10 maps opaque unobserved carrier padding1-9; full-file content unknown; complete disclosure rejected.',
      'Retirement uses explicitly declared finite normalized fact inventory, not NLP adjudication or actual dependency/adoption evidence.',
      'Snapshot conflict and lost response are local safety/recovery probes only; no semantic opportunity or duplicate writes.',
      'Identity retains one natural opportunity/two claims; controlled key probes and identical replay are unrun/blocked, never extra opportunities.',
      'Synthetic secret remains one complete original unit with no real credential; future provider boundary screening remains unrun.',
      'No existing runtime harness, SDK, provider, auth, configuration, native tool context, SQLite, or runbook command was executed.',
    ],
  };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(runPopulation(), null, 2)}\n`);
module.exports = { runPopulation };
