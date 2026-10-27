const assert = require('node:assert/strict');
const fs = require('node:fs');

function assertDirectoryTargets(actual, expected) {
  assert.deepEqual(actual.map((directory) => fs.realpathSync.native(directory)),
    expected.map((directory) => fs.realpathSync.native(directory)));
}

module.exports = { assertDirectoryTargets };
