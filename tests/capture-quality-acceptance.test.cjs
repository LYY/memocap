const { readdirSync } = require('node:fs');
const { join } = require('node:path');

const directory = join(__dirname, 'capture-quality-acceptance');
const tests = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.cjs'))
  .map((entry) => entry.name)
  .sort();

for (const name of tests) require(join(directory, name));
