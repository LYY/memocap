const test = require('node:test');
const assert = require('node:assert/strict');
const { constants } = require('node:fs');
const { metadataMemoryIO } = require('./metadata-memory-io.cjs');

const exclusive = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

test('memory metadata I/O refuses exclusive creation over an existing source without truncation', () => {
  const { io, mutations, descriptors } = metadataMemoryIO('/synthetic/source.json', '{}');
  const before = io.lstatSync('/synthetic/source.json');

  assert.throws(() => io.openSync('/synthetic/source.json', exclusive, 0o600), { code: 'EEXIST' });

  assert.equal(io.readFileSync('/synthetic/source.json', 'utf8'), '{}');
  assert.equal(io.lstatSync('/synthetic/source.json').ino, before.ino);
  assert.deepEqual(mutations, []);
  assert.equal(descriptors.size, 0);
});

test('memory metadata I/O writes through a numeric descriptor with stable file identity and retires it on close', () => {
  const { io } = metadataMemoryIO('/synthetic/source.json', '{}');
  io.mkdirSync('/synthetic/inputs', { mode: 0o700 });
  const file = '/synthetic/inputs/profile.json';
  const fd = io.openSync(file, exclusive, 0o600);
  const opened = io.fstatSync(fd);

  io.writeFileSync(fd, '{"model":"synthetic"}');

  assert.equal(typeof fd, 'number');
  assert.equal(opened.isFile(), true);
  assert.equal(opened.mode, 0o600);
  assert.equal(opened.uid, process.getuid());
  assert.equal(opened.nlink, 1);
  const current = io.lstatSync(file);
  assert.deepEqual([current.dev, current.ino, current.uid], [opened.dev, opened.ino, opened.uid]);
  assert.notEqual(current.ino, io.lstatSync('/synthetic/source.json').ino);
  assert.equal(io.readFileSync(file, 'utf8'), '{"model":"synthetic"}');
  io.closeSync(fd);
  assert.throws(() => io.fstatSync(fd), { code: 'EBADF' });
  assert.throws(() => io.writeFileSync(fd, '{}'), { code: 'EBADF' });
});
