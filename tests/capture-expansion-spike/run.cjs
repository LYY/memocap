const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness } = require('./harness.cjs');
const { acquisition } = require('./acquisition.cjs');
const { generation } = require('./generation.cjs');
const { probes } = require('./probes.cjs');
const { digest, write } = require('../setup-package-lifecycle-fixture.cjs');

async function runSpike(t) {
  const repo = path.resolve(__dirname, '../..');
  const destination = path.join(repo, '.omo/evidence/capture-expansion');
  const version = process.env.MEMOCAP_CAPTURE_PACKAGED_HOST === '1' ? '1193' : '1195';
  const stamp = `spike-${version}-${Date.now()}`;
  const runs = [];
  const manifests = Object.fromEntries(fs.readdirSync(__dirname).filter((name) => /\.(?:cjs|mjs)$/.test(name))
    .map((name) => [name, digest(fs.readFileSync(path.join(__dirname, name)))]));
  manifests['../capture-expansion-spike.integration.test.cjs'] = digest(fs.readFileSync(path.join(__dirname, '../capture-expansion-spike.integration.test.cjs')));
  const common = { host: version, kind: 'real_host_mechanism_spike', production_proof: 'not_run',
    command: `MEMOCAP_CAPTURE_PACKAGED_HOST=${process.env.MEMOCAP_CAPTURE_PACKAGED_HOST} MEMOCAP_CAPTURE_EXPANSION_SPIKE=1 node --test tests/capture-expansion-spike.integration.test.cjs`,
    native_sha256: digest(fs.readFileSync(path.join(repo, 'target/debug/memocap'))), node_version: process.version,
    model_quality: 'not_tested_scripted_wire_only', profiles: 'SPIKE_only_not_product_defaults',
    dirty_user_files: 'N/A_exclusive_new_test_and_scratch_scope', credentials: 'N/A_no_access', test_sha256: manifests };
  const qa1 = { ...common, runs: [] };
  const qa2 = { ...common, runs: [] };
  try {
    for (const mode of ['negative_control_0.6.0', 'scratch_prototype']) {
      process.stderr.write(`WORKING ${version} ${mode}: real 32/128 completed sessions then native generation contract\n`);
      const evidence = { mode, commands: [], cleanup: {}, cases: [], probes: [], paid_provider_requests: 0 };
      runs.push(evidence);
      const scratch = path.join(destination, stamp, mode);
      const current = await harness(evidence, scratch);
      try {
        await acquisition(current, evidence);
        qa1.runs.push({ mode, host: evidence.host, cases: evidence.cases });
        const generated = { mode };
        await generation(current, generated);
        qa2.runs.push({ mode, host: evidence.host, ...generated });
        if (mode === 'scratch_prototype') await probes(current, evidence);
        assert.deepEqual(current.provider.errors, []);
        evidence.status = 'passed_mechanism_spike';
      } catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
      finally {
        await current.close();
        write(path.join(scratch, 'receipt.json'), JSON.stringify(evidence, null, 2));
      }
    }
    qa1.status = 'passed_scratch_mechanism_production_not_run';
    qa2.status = 'passed_scratch_mechanism_production_not_run';
  } catch (error) {
    qa1.status = qa2.status = 'blocked_or_failed';
    qa1.error = qa2.error = error.stack;
    throw error;
  } finally {
    for (const evidence of runs) {
      const receipt = { mode: evidence.mode, status: evidence.status, cleanup: evidence.cleanup, probes: evidence.probes,
        delta: evidence.delta, original_capture_hashes: evidence.original_capture_hashes, commands: evidence.commands };
      qa1.receipts ||= []; qa2.receipts ||= [];
      qa1.receipts.push(receipt); qa2.receipts.push(receipt);
    }
    write(path.join(destination, `acquisition-${version}.json`), JSON.stringify(qa1, null, 2));
    write(path.join(destination, `generation-${version}.json`), JSON.stringify(qa2, null, 2));
    t.diagnostic(JSON.stringify({ acquisition: qa1.status, generation: qa2.status, cleanup: runs.map((run) => run.cleanup) }));
  }
}

async function runProbes(t) {
  const repo = path.resolve(__dirname, '../..');
  const version = process.env.MEMOCAP_CAPTURE_PACKAGED_HOST === '1' ? '1193' : '1195';
  const scratch = path.join(repo, `.omo/evidence/capture-expansion/spike-probes-${version}-${Date.now()}`);
  const evidence = { mode: 'scratch_prototype', commands: [], cleanup: {}, probes: [] };
  const current = await harness(evidence, scratch);
  try { await probes(current, evidence); evidence.status = 'passed_boundary_probes'; }
  catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
  finally {
    await current.close();
    write(path.join(scratch, 'receipt.json'), JSON.stringify(evidence, null, 2));
    t.diagnostic(JSON.stringify({ status: evidence.status, probes: evidence.probes, cleanup: evidence.cleanup }));
  }
}
module.exports = { runSpike, runProbes };
