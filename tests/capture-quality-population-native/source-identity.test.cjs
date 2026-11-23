const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { sources } = require('./authorization.cjs');

test('native source digest changes when the shared OpenCode host gate changes', ({ mock }) => {
  const gate = path.resolve(__dirname, '../../lib/opencode-host.js');
  const { digest } = sources();
  const readFileSync = fs.readFileSync;
  const changed = Buffer.concat([readFileSync(gate), Buffer.from('\n// fingerprint probe\n')]);

  mock.method(fs, 'readFileSync', (file, options) => file === gate ? changed : readFileSync(file, options));

  assert.notEqual(sources().digest, digest);
});
