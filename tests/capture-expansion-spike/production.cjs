const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { harness } = require('./harness.cjs');
const { acquisition } = require('./acquisition.cjs');
const { generation } = require('./generation.cjs');
const { probes } = require('./probes.cjs');
const { units } = require('./units.cjs');
const { cancelAfterCommit, mismatchAndBudget } = require('../opencode-capture/cases.cjs');
const { nativeDenial, unknownReceipt, parentError } = require('../opencode-capture/races.cjs');
const { digest, write } = require('../setup-package-lifecycle-fixture.cjs');
const repo = path.resolve(__dirname, '../..');
const destination = path.join(repo, '.omo/evidence/capture-expansion');
const frozen = () => Object.fromEntries(['acquisition-1193.json', 'acquisition-1195.json', 'generation-1193.json', 'generation-1195.json']
  .map((name) => [name, digest(fs.readFileSync(path.join(destination, name)))]));

function aggregate() {
  const runID = process.env.MEMOCAP_CAPTURE_PRODUCTION_RUN;
  const runs = ['1193', '1195'].map((version) => JSON.parse(fs.readFileSync(path.join(destination, `production-acquisition-${runID}-${version}.json`))));
  assert.ok(runs.every((run) => run.status === 'passed_product_acquisition'));
  assert.equal(runs[0].run_id, runs[1].run_id);
  assert.deepEqual(runs[0].capture_source_sha256, runs[1].capture_source_sha256);
  write(path.join(destination, `production-acquisition-${runID}.json`), JSON.stringify({ status: 'DoneClaim_production_bounded_acquisition',
    model_quality: 'not_tested_scripted_wire_only', support_slice: 'not_implemented', frozen_spike_artifacts: frozen(), runs }, null, 2));
}

async function runProduction(t) {
  const version = process.env.MEMOCAP_CAPTURE_PACKAGED_HOST === '1' ? '1193' : '1195';
  const scratch = path.join(destination, `spike-production-${version}-${Date.now()}`);
  const before = frozen();
  const evidence = { mode: 'production', run_id: process.env.MEMOCAP_CAPTURE_PRODUCTION_RUN, commands: [], cleanup: {}, cases: [], probes: [],
    command: `MEMOCAP_CAPTURE_PACKAGED_HOST=${process.env.MEMOCAP_CAPTURE_PACKAGED_HOST} MEMOCAP_CAPTURE_PRODUCTION=1 MEMOCAP_CAPTURE_PRODUCTION_RUN=${process.env.MEMOCAP_CAPTURE_PRODUCTION_RUN} node --test --test-name-pattern='production bounded' tests/capture-expansion-spike.integration.test.cjs` };
  assert.ok(evidence.run_id);
  evidence.retention_semantics = {
    scope: 'Actual production createObserved cache after bounds/TTL eviction; excludes worker snapshots, SDK responses and provider inputs.',
    counts: 'sessions/turns/messages/parts count retained cache containers and part slots including omission tombstones; evidenceParts counts slots with a value.',
    bytes: 'UTF-8 JSON.stringify of retained Map entries including identifiers, timestamps, completion metadata and tombstones; empty cache is zero. Not JS heap usage.',
    levels: 'sessionTurns/sessionBytes, turnMessages/turnParts/turnBytes, messageParts/messageBytes and partBytes are largest currently retained instance; partBytes measures projected value only.',
    maxima: 'maxima is lifetime high-water for each counter after bounds. row_maxima is max sampled current counters during this 32/128-turn row, across the bounded production cache.',
    caps: 'sessions global; turns per session; messages per turn; parts per message; partBytes projected value; turnBytes whole turn; globalBytes serialized cache; TTL 120s. Candidate profile, not final tuning.',
  };
  evidence.test_sha256 = Object.fromEntries(fs.readdirSync(__dirname).filter((name) => /\.(?:cjs|mjs)$/.test(name))
    .map((name) => [name, digest(fs.readFileSync(path.join(__dirname, name)))]));
  const current = await harness(evidence, scratch);
  try {
    const profile = await import(pathToFileURL(path.join(evidence.package_root, 'plugin/capture/observed.js')));
    evidence.profile = profile.observedCandidateProfile;
    evidence.profile_status = profile.observedProfileStatus;
    for (const [name, hash] of Object.entries(evidence.capture_source_sha256)) assert.equal(digest(fs.readFileSync(path.join(repo, name))), hash);
    await units(current, evidence);
    process.stderr.write(`WORKING ${version} product package units=${evidence.units.passed}, real 32/128 turns next\n`);
    await acquisition(current, evidence);
    evidence.generation = { mode: 'production' };
    await generation(current, evidence.generation);
    await probes(current, evidence);
    await nativeDenial(current, evidence);
    await mismatchAndBudget(current, evidence);
    await cancelAfterCommit(current, evidence);
    await cancelAfterCommit(current, evidence, true);
    await unknownReceipt(current, evidence);
    await parentError(current, evidence);
    const sdk = current.control.events.filter((event) => event.phase === 'capture.sdk');
    const children = new Set(sdk.filter((event) => event.method === 'session.create').map((event) => event.response.data.id));
    const histories = sdk.filter((event) => event.method === 'session.messages');
    assert.ok(histories.length > 0);
    assert.ok(histories.every((event) => children.has(event.request.path.id)));
    evidence.parent_history_calls = 0;
    evidence.capture_sdk = sdk;
    evidence.adversarial_classes = ['secret_or_malformed_units', 'oversized_body_and_metadata', 'out_of_order_completion',
      'worker_synthetic_and_source_forgery', 'finite_capacity_ttl_and_disposal', 'cancel_and_resume_before_spawn',
      'new_input_and_stale_generation', 'native_permission_mismatch_and_budget', 'started_write_independent_readback_and_unknown_receipt'];
    evidence.dirty_user_files = 'N/A_only_owned_product_and_isolated_test_fixtures';
    evidence.credentials = 'N/A_no_access_private_HOME_XDG_scripted_provider';
    assert.deepEqual(current.provider.errors, []);
    evidence.status = 'passed_product_acquisition';
  } catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
  finally {
    await current.close();
    evidence.frozen_spike_artifacts_unchanged = JSON.stringify(before) === JSON.stringify(frozen());
    write(path.join(scratch, 'receipt.json'), JSON.stringify(evidence, null, 2));
    write(path.join(destination, `production-acquisition-${evidence.run_id}-${version}.json`), JSON.stringify(evidence, null, 2));
    t.diagnostic(JSON.stringify({ status: evidence.status, cleanup: evidence.cleanup, units: evidence.units }));
    assert.equal(evidence.frozen_spike_artifacts_unchanged, true);
  }
}
module.exports = { runProduction, aggregate };
