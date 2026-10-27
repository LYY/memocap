const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { assertDirectoryTargets } = require('./opencode-v1/paths.cjs');

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memocap directory identity '));
  context.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
    context.diagnostic('temporary directory removed; synchronous children exited; no listeners opened');
  });
  const directories = ['A', 'B', 'other'].map((name) => path.join(root, name));
  for (const directory of directories) fs.mkdirSync(directory);
  return { root, expected: directories.slice(0, 2), other: directories[2], missing: path.join(root, 'missing') };
}

test('directory targets accept dot spellings of independently selected directories', (context) => {
  const { root, expected } = fixture(context);
  const actual = ['A', 'B'].map((name) => `${root}${path.sep}.${path.sep}${name}`);

  assertDirectoryTargets(actual, expected);
});

test('directory targets accept real child native filesystem output in order', (context) => {
  const { root, expected } = fixture(context);
  const child = spawnSync(process.execPath, ['-e',
    "console.log(JSON.stringify(process.argv.slice(1).map(p => require('node:fs').realpathSync.native(p))))",
    ...['A', 'B'].map((name) => `${root}${path.sep}.${path.sep}${name}`)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const actual = JSON.parse(child.stdout);
  context.diagnostic(JSON.stringify({ pid: child.pid, actual, expected }));

  assertDirectoryTargets(actual, expected);
});

if (process.platform === 'win32') {
  test('directory targets accept native Windows namespace spellings', (context) => {
    const { expected } = fixture(context);
    const actual = expected.map((directory) => path.toNamespacedPath(directory));

    assertDirectoryTargets(actual, expected);
  });

  test('directory targets accept Windows short names against expanded native paths', (context) => {
    const { expected } = fixture(context);
    const short = expected.map((directory) => {
      const child = spawnSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'),
        ['/d', '/c', `for %I in ("${directory}") do @echo %~sI`], { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 0, child.stderr);
      return child.stdout.trim();
    });
    const expanded = expected.map((directory) => fs.realpathSync.native(directory));
    context.diagnostic(JSON.stringify({ short, expanded, distinct_short_alias: short.some((directory, index) => directory !== expanded[index]) }));

    assertDirectoryTargets(short.map((directory) => path.toNamespacedPath(directory)), expanded);
  });
}

for (const scenario of ['different', 'reversed', 'missing actual', 'missing expected', 'same missing']) {
  test(`directory targets reject ${scenario} directories`, (context) => {
    const { expected, other, missing } = fixture(context);
    const cases = {
      different: [[expected[0], other], expected],
      reversed: [[expected[1], expected[0]], expected],
      'missing actual': [[expected[0], missing], expected],
      'missing expected': [expected, [expected[0], missing]],
      'same missing': [[missing], [missing]],
    };
    const [actual, selected] = cases[scenario];

    assert.throws(() => assertDirectoryTargets(actual, selected),
      scenario.includes('missing') ? { code: 'ENOENT' } : { code: 'ERR_ASSERTION' });
  });
}
