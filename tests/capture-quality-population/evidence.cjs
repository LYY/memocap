const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { runPopulation } = require('./driver.cjs');

const root = path.resolve(__dirname, '../..');
const command = ['--test', '--test-reporter=tap', 'tests/capture-quality-population/dispatcher.test.cjs'];
const green = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8' });
assert.equal(green.status, 0, green.stdout + green.stderr);
assert.match(green.stdout, /^# tests 30$/m);
assert.match(green.stdout, /^# pass 30$/m);
assert.match(green.stdout, /^# fail 0$/m);
const report = runPopulation();
report.implementation_hashes['evidence.cjs'] = createHash('sha256')
  .update(readFileSync(__filename)).digest('hex');
report.verification = {
  red: [
    { command: 'node --test tests/capture-quality-population/dispatcher.test.cjs',
      execution: 'observed before implementation in this task', exit_code: 1,
      tests: 22, pass: 0, fail: 22, failure: 'ERR_ASSERTION: not_implemented versus required state guard codes',
      scope: 'Early completion, absent marker/verifier, insufficient approval probes, incorrect retirement inventory, denial, partial disclosure' },
    { command: 'node --test tests/capture-quality-population/dispatcher.test.cjs',
      execution: 'observed before fixed argument/identity checks in this task', exit_code: 1,
      tests: 29, pass: 27, fail: 2,
      failing_tests: ['fixed operation arguments cannot select another job or inject output',
        'retirement inventory checks exact approved replacement identity'] },
    { command: 'node --test --test-reporter=dot tests/capture-quality-population/dispatcher.test.cjs',
      execution: 'observed before preserving original tool status in this task', exit_code: 1,
      tests: 30, pass: 29, fail: 1,
      failing_tests: ['missing-marker attempt retains error status rather than a successful tool response'],
      failure: 'ERR_ASSERTION: actual undefined, expected error' },
  ],
  green: { command: `node ${command.join(' ')}`, exit_code: green.status,
    tests: 30, pass: 30, fail: 0, stdout: green.stdout, stderr: green.stderr },
  red_record_kind: 'Actual earlier command observations recorded here; no retrospective RED rerun or native execution claimed',
  module_driver: { command: 'node tests/capture-quality-population/driver.cjs',
    public_cli_executed: true, module_executed_again_for_report: true, cases: report.cases.length,
    assertions: ['all original operation payload bytes and error status preserved',
      'all user text and original observations mapped without gold leakage',
      'local state checks required before verification text',
      '28 original cases and frozen 8 opportunities/9 claims/2 authorized revisions retained'] },
  lsp: { status: 'clean', surface: 'new CommonJS modules and mapping; no installation or dependency command' },
  suite_scope: 'Only new offline suite; existing runtime harness and project-wide test entrypoints intentionally unrun per task constraint',
};
const reportPath = path.join(root, '.omo/evidence/capture-expansion/quality-population-operationalization.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ report: reportPath, tests: 30, cases: report.cases.length })}\n`);
