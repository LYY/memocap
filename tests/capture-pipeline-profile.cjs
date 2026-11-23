const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { readObservation } = require('./capture-source-host/synthetic.cjs');

async function main() {
  const { adaptSource, sourceBundles, selectBundles } = await import('../plugin/capture/sources.js');
  const { bundleProfiles } = await import('../plugin/capture/sources/profile.js');
  const fixtures = [400, 1200, 2800, 3400].map((length) => {
    const start = '# Alpha route\n\nApproval is required.\n';
    const end = '\n## Restrictions\nNever use for beta; independently GET the final result.';
    const text = start + 'x'.repeat(length - [...start, ...end].length) + end;
    return { length, sha256: createHash('sha256').update(text).digest('hex'), observation: readObservation(text) };
  });
  const rows = [];
  for (const profile of Object.values(bundleProfiles)) {
    const began = performance.now();
    const cpu = process.cpuUsage();
    let selectedBytes = 0;
    const admitted = [];
    for (const fixture of fixtures) {
      const result = adaptSource(fixture.observation);
      assert.equal(result.status, 'source');
      let selection;
      for (let repetition = 0; repetition < 100; repetition++) {
        const pool = sourceBundles([result.source], profile);
        selection = selectBundles(pool.bundles, { user_id: 'user', text: 'Alpha route approval' }, profile);
      }
      const bytes = Buffer.byteLength(JSON.stringify(selection.bundles.flatMap((bundle) => bundle.units)));
      assert.ok(bytes <= profile.max_selected_bytes);
      selectedBytes = Math.max(selectedBytes, bytes);
      admitted.push({ source_codepoints: fixture.length, whole_bundle_selected: selection.bundles.length > 0,
        selected_units: selection.bundles.flatMap((bundle) => bundle.units).length, selected_bytes: bytes });
    }
    const used = process.cpuUsage(cpu);
    rows.push({ name: profile.name, cap_codepoints: profile.max_bundle_codepoints, iterations_per_fixture: 100,
      wall_ms: performance.now() - began, cpu_user_ms: used.user / 1000, cpu_system_ms: used.system / 1000,
      maximum_selected_bytes: selectedBytes, admitted });
  }
  const evidence = { kind: 'finite_context_budget_comparison', selected: 'capture-bundle-3200',
    rationale: 'Preserve bounded sibling restrictions for 1200/2800-codepoint sources; drop whole 3400-codepoint sources. Quote/body budgets remain 800/1200.',
    semantic_quality_or_holdout_evaluation: false, fixtures: fixtures.map(({ length, sha256 }) => ({ length, sha256 })), rows };
  fs.writeFileSync(path.resolve(__dirname, '../.omo/evidence/capture-expansion/capture-pipeline-profiles.json'), JSON.stringify(evidence, null, 2));
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
