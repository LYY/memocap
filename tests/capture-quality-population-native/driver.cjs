const assert = require('node:assert/strict');
const { mapping, tuning, resolveCase } = require('../capture-quality-population/inputs.cjs');
const { runCase } = require('./adapter.cjs');
const { inventory, createMeter } = require('./inventory.cjs');
const { fakeHost } = require('./fake-host.cjs');
const { adversaries, offline } = require('./scenarios.cjs');

async function runOffline() {
  const meter = createMeter(offline, 'offline');
  const cases = [];
  let modelPackets = 0;
  for (const { id } of mapping.cases) {
    const host = fakeHost();
    const budgetBefore = meter.snapshot();
    if (id === 'synthetic-secret') host.open = () => assert.fail('screened unit opened host');
    const result = await runCase(id, { host, budget: offline, meter });
    assert.equal(result.status, 'wired', `${id}: ${result.reason}`);
    if (id === 'synthetic-secret') {
      const original = resolveCase(id).original;
      assert.deepEqual(result.turns.map((turn) => turn.status), original.turns.map(() => 'screened_whole_unit'));
      assert.deepEqual(result.turns.map((turn) => turn.semantic), original.turns.map(() => 'unexercised'));
      assert.equal(result.transport, null); assert.equal(result.trace, null); assert.equal(result.cleanup, null);
      assert.deepEqual(result.custody, []); assert.deepEqual(result.seeds, []);
      assert.deepEqual(result.setup_attempts, []); assert.equal(result.setup_recovery_required, false);
      assert.deepEqual(result.completion_evidence, []); assert.deepEqual(result.budget_used, budgetBefore);
      assert.deepEqual(host.packets, []); assert.deepEqual(host.translations, []); assert.deepEqual(host.memory, []);
      assert.deepEqual(host.stats, { open: 0, closed: 0, children: 0, native_processes: 0, provider_requests: 0, writes: 0 });
      assert.equal(result.runtime, 'NOT_RUN'); assert.equal(result.quality_credit, false);
    } else {
      assert.equal(result.transport.observed, result.transport.planned);
      assert.equal(result.cleanup.exited, true); assert.equal(result.cleanup.children, 0);
    }
    for (const packet of host.packets) {
      const text = JSON.stringify(packet);
      assert.ok(!/"(?:gold|expected_body|proposal|identity_claims|controls|caseID|case_id)"\s*:/.test(text));
      for (const entry of mapping.cases) assert.ok(!text.includes(`"${entry.id}"`));
      modelPackets++;
    }
    cases.push(result);
  }
  return { schema: 1, kind: 'full_population_native_offline_wiring', status: 'offline_wiring_verified',
    node: process.version, frozen: { sha256: mapping.tuning_sha256, cases: 28, capture: tuning.capture.length,
      capture_opportunities: tuning.capture.filter((row) => row.gold.action === 'save').length,
      capture_claims: tuning.capture.filter((row) => row.gold.action === 'save').reduce((sum, row) => sum + row.gold.claims.length, 0),
      maintenance: tuning.maintenance.length, authorized_mutations: tuning.maintenance.filter((row) => row.gold.mutations === 1).length },
    cases, adversaries: await adversaries(), model_packets: modelPackets, inventory: inventory(), budget_used: meter.snapshot(),
    execution: { native_host: 'NOT_RUN', model: 'NOT_RUN', sqlite: 'NOT_RUN', provider_requests: 0,
      native_processes: 0, sockets: 0, materializations: 0, holdout_decoded: false, qa7: 'NOT_RUN', quality_credit: false },
    remaining_runtime_prerequisites: [
      'A separate explicit population grant bound to this inventory, model/profile/code digests, private paths and finite request/byte/time/write limits; consumed canary grant is unusable.',
      'runtime.cjs supplies concrete OpenCode 1.19.5 plugin/Unix control/owned carrier/native bridge composition; startup requires a NEW exact grant and is NOT_RUN.',
      'Its concrete private carrier IO and isolated native seed/readback need genuine future runtime verification; exact tool framing remains NOT_RUN.',
      'Actual full native reads and explicit use declarations, target-specific mutation grants and native ToolContext.ask; comparison-only records never get fabricated use IDs.',
      'Native invocation observer installed at the production beforeSpawn boundary and real independent readback; unknown attempts retain recovery data and never replay.',
      'Capture admission/support/identity/frozen-candidate issuance have opt-in production observations; any absent stage stays blocked. Capture has no opaque proposal token.',
      'Snapshot-conflict native CAS needs legitimate issued request plus separately charged concurrent setup at the actual transaction boundary. Lost-response native recovery needs genuine prior dispatch evidence; finite dispatcher probes alone prove neither.',
      'Finite tuning/model/profile/prompt/scoring/gates freeze and independent claim/condition adjudication before a separately supplied frozen holdout population. No holdout opened here.',
    ] };
}
if (require.main === module) runOffline().then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
  .catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
module.exports = { runOffline, runNative: require('./runtime.cjs').runNative };
