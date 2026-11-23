const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const tests = fs.readdirSync(path.join(root, 'tests')).filter((file) =>
  /^(capture-|maintenance-|plugin-capture-).*\.test\.cjs$/.test(file) && !file.endsWith('.integration.test.cjs'))
  .map((file) => `tests/${file}`);
for (const directory of ['capture-quality-native', 'capture-quality-population', 'capture-quality-population-native']) {
  tests.push(...fs.readdirSync(path.join(root, 'tests', directory)).filter((file) => file.endsWith('.test.cjs'))
    .map((file) => `tests/${directory}/${file}`));
}
const args = ['--experimental-vm-modules', '--test', '--test-reporter=tap', ...tests.sort()];
const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 16777216,
  env: { HOME: '/synthetic/home', PATH: '/usr/bin:/bin', TMPDIR: '/tmp' } });
if (result.status !== 0 || result.error) {
  process.stderr.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  throw result.error ?? new Error(`offline_tests_exit_${result.status}`);
}
const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map((key) => {
  const match = result.stdout.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
  assert.ok(match, `missing_${key}`); return [key, Number(match[1])];
}));
assert.equal(counts.tests, counts.pass); assert.equal(counts.fail, 0); assert.equal(counts.skipped, 0);
process.stdout.write(`${JSON.stringify({ status: 'offline_verified', files: tests.length, counts,
  command: [process.execPath, ...args], real_host: 'NOT_RUN', provider: 'NOT_RUN', native: 'NOT_RUN', sqlite: 'NOT_RUN' })}\n`);
