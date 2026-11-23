const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { digest } = require('../setup-package-lifecycle-fixture.cjs');
const baseline = '905a066aa4e67e9932e0f2af135aaa1cf170ad37';

function packageSource(prepared, destination, evidence) {
  if (evidence.mode === 'production') {
    fs.cpSync(prepared.runnerRoot, destination, { recursive: true });
    evidence.loaded_source = 'current_npm_package_without_source_substitutions';
  } else {
    const archive = execFileSync('git', ['archive', baseline], {
      cwd: path.resolve(__dirname, '../..'), env: { ...process.env, GIT_MASTER: '1' }, maxBuffer: 32 * 1024 * 1024,
    });
    fs.mkdirSync(destination, { recursive: true });
    execFileSync('tar', ['-x', '-C', destination], { input: archive });
    evidence.loaded_source = { git_archive: baseline, archive_sha256: digest(archive) };
  }
  evidence.capture_source_sha256 = Object.fromEntries(['plugin/cli.js', ...fs.readdirSync(path.join(destination, 'plugin/capture'), { recursive: true })
    .filter((name) => name.endsWith('.js')).map((name) => `plugin/capture/${name}`)]
    .map((name) => [name, digest(fs.readFileSync(path.join(destination, name)))]));
}
module.exports = { packageSource };
