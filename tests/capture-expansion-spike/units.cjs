const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { digest, write } = require('../setup-package-lifecycle-fixture.cjs');
const files = ['capture-observed.test.cjs', 'capture-admission.test.cjs', 'capture-evidence.test.cjs',
  'capture-identity.test.cjs', 'capture-duplicates.test.cjs', 'capture-lifecycle.test.cjs', 'capture-binding.test.cjs',
  'plugin-capture-boundary.test.cjs'];

async function units(current, evidence) {
  const root = evidence.package_root;
  const testRoot = path.join(root, 'tests');
  fs.mkdirSync(testRoot, { recursive: true });
  const sources = [...files, 'plugin-fixture.cjs', 'plugin-access-fixture.cjs'];
  for (const name of sources) fs.copyFileSync(path.join(__dirname, '..', name), path.join(testRoot, name));
  evidence.unit_source_sha256 = Object.fromEntries(sources.map((name) => [name, digest(fs.readFileSync(path.join(testRoot, name)))]));
  const executed = await current.fixture.command(process.execPath, ['--test', '--test-reporter=tap', ...files.map((name) => path.join(testRoot, name))], { cwd: root });
  const log = path.join(root, '../unit.log');
  write(log, executed.stdout + executed.stderr);
  assert.match(executed.stdout, /# fail 0\n/);
  assert.match(executed.stdout, /# skipped 0\n/);
  evidence.units = { log, passed: Number(/# pass (\d+)\n/.exec(executed.stdout)[1]), failed: 0, skipped: 0,
    dependencies: 'private_fixture_package_only_root_untouched' };
}
module.exports = { units };
