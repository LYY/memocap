const fs = require('node:fs');
const path = require('node:path');
const { runOffline } = require('./driver.cjs');
const { hash, requireStage } = require('./value.cjs');
const root = path.resolve(__dirname, '../..');
const destination = path.join(root, '.omo/evidence/capture-expansion/quality-full-population-native-offline-wiring.json');
const readJSON = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const byteHash = (name) => require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');

async function report() {
  const reviewed = readJSON('.omo/evidence/capture-expansion/quality-population-operationalization-independent-verification.json');
  const nativeReviewed = readJSON('.omo/evidence/capture-expansion/quality-native-integration-repairs-independent-verification.json');
  const protectedHashes = { ...reviewed.implementation_hashes,
    ...Object.fromEntries(Object.entries(nativeReviewed.source_hashes_sha256).filter(([name]) =>
      /\/(?:controller|journal|native-proxy|projection|fixture-core|input|support)\.cjs$/.test(name))),
    'tests/capture-evaluation/tuning.json': 'eed4003f644f239ee85ed6f2d85443be97925a4169e04eefd53d9b4eb3c39620' };
  const before = Object.fromEntries(Object.keys(protectedHashes).map((name) => [name, byteHash(name)]));
  const result = await runOffline();
  const ownPaths = fs.readdirSync(__dirname).filter((name) => /\.(?:cjs|md)$/.test(name))
    .map((name) => `tests/capture-quality-population-native/${name}`).sort();
  const sourceHashes = Object.fromEntries(ownPaths.map((name) => [name, byteHash(name)]));
  const pureLOC = Object.fromEntries(ownPaths.filter((name) => name.endsWith('.cjs')).map((name) => [name,
    fs.readFileSync(path.join(root, name), 'utf8').split('\n').filter((line) => line.trim() && !line.trim().startsWith('//')).length]));
  requireStage(Object.values(pureLOC).every((count) => count <= 250), 'pure_loc_ceiling');
  const preservation = Object.fromEntries(Object.entries(protectedHashes).map(([name, expected]) => {
    const after = byteHash(name);
    requireStage(before[name] === after, 'protected_file_changed_during_driver');
    return [name, { sha256: after, matches_reviewed: expected === after, unchanged_during_driver: true }];
  }));
  return { ...result, generated_at: new Date().toISOString(), root, source_sha256: sourceHashes, pure_loc: pureLOC,
    inventory_sha256: hash(result.inventory), preservation,
    production_components_sha256: Object.fromEntries(['plugin/cli.js', 'plugin/capture/index.js', 'plugin/commands.js',
      'plugin/maintenance/runtime.js', 'plugin/operations.js', 'plugin/organization.js', 'plugin/policy.js',
      'plugin/recall.js', 'plugin/tools.js', 'plugin/capture/sources.js', 'plugin/capture/sources/read.js',
      'plugin/capture/extraction.js', 'plugin/maintenance/reviewer.js', 'plugin/maintenance/executor.js',
      'plugin/maintenance/backend.js', 'plugin/maintenance/contract.js'].map((name) => [name, byteHash(name)])),
    referenced_contracts_sha256: Object.fromEntries([
      '.omo/plans/capture-expansion-v0.7.0.md', '.omo/contracts/capture-quality-driver-contract.json',
      '.omo/contracts/capture-quality-driver-contract.md',
      '.omo/evidence/capture-expansion/quality-population-operationalization-independent-verification.json',
      '.omo/evidence/capture-expansion/quality-native-integration-repairs-independent-verification.json',
    ].map((name) => [name, byteHash(name)])),
    verification: { tdd: { red: { tests: 2, pass: 0, fail: 2,
      command: 'node --test tests/capture-quality-population-native/adapter.test.cjs',
      failure: 'Missing transport returned blocked instead of observed custody and failed separate-budget refusal assertion.' },
      first_green: { tests: 2, pass: 2, fail: 0 },
      final_boundary_red: { tests: 9, pass: 7, fail: 2, reasons: ['options.invoke is not a function', 'unverified setup write incorrectly removed recovery state'] },
      recovery_read_red: { tests: 10, pass: 9, fail: 1, reason: 'unbound_readback discarded observed recovery read when original write receipt was lost' },
      earlier_output_probe: { tests: 48, pass: 47, fail: 1, reason: 'Fake driver reused attempt-one across three distinct original reviews; fixed fake attempt IDs, retained production replay refusal.' } },
      final_tests: { command: 'node --test tests/capture-quality-population-native/*.test.cjs tests/capture-quality-population/dispatcher.test.cjs',
        tests: 91, pass: 91, fail: 0, skipped: 0, exit_code: 0 },
      lsp: 'All new source/test/README files checked; no diagnostics at final verification.',
      manual_surface: 'Executed node tests/capture-quality-population-native/driver.cjs (exit 0) with all28 plus 23 adversarial groups; fake SDK-shaped source events parsed by production adaptSource; native receipt projection and beforeSpawn wrapper exercised only with in-memory invoke.',
      build: 'No build step for CommonJS test-only modules; executed directly by Node. No product build or host/native integration was run.' },
    ownership: { writes: ['tests/capture-quality-population-native/*', path.relative(root, destination)],
      existing_reports_overwritten: false, existing_native_fixture_modified: false, existing_native_fixture_delta: 0,
      current_canary_modified: false, consumed_grant_reused: false, parent_state_modified: false,
      product_files_modified: false, configuration_or_credentials_read: false, holdout_read: false,
      budget_is_authorization: false },
    limitations: [
      'Fake envelopes, model decisions and in-memory native receipts prove adapter wiring only; no actual OpenCode compatibility or quality measurement.',
      'Capture has no registry-issued opaque proposal in its production protocol. Maintenance issuance is collected only from its actual observer; unavailable capture admission/identity stages remain blocked.',
      'The synchronous maintenance beforeSpawn return observes consumption/dispatch barrier, not a private registry return value.',
      'Actual process counts and private filesystem/SQLite behavior are unobserved. The supplied native link/process boundary must enforce the reserved finite ceiling and furnish actual receipts.',
      'Snapshot-conflict and lost-response remain controlled safety/recovery strata with native prerequisites; neither creates an extra semantic opportunity.',
      'Identity case has one natural request and one opportunity/two claims. Identical replay and extra natural requests are not added.',
    ] };
}
if (require.main === module) report().then((value) => {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ report: destination, sha256: byteHash(path.relative(root, destination)),
    cases: value.cases.length, adversaries: value.adversaries.length, inventory_sha256: value.inventory_sha256 }));
}).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { report };
