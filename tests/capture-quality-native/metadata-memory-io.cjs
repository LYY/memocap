const assert = require('node:assert/strict');
const { constants } = require('node:fs');
const path = require('node:path');

function metadataMemoryIO(sourceConfig, source) {
  const nodes = new Map();
  const descriptors = new Map();
  const opens = []; const reads = []; const mutations = [];
  let inode = 0; let descriptor = 100;
  const failure = (code) => Object.assign(new Error(code), { code });
  const nodeAt = (file) => {
    const node = nodes.get(file);
    if (!node) throw failure('ENOENT');
    return node;
  };
  const handleAt = (fd) => {
    const handle = descriptors.get(fd);
    if (!handle) throw failure('EBADF');
    return handle;
  };
  const add = (file, entry) => {
    if (nodes.has(file)) throw failure('EEXIST');
    nodes.set(file, { ...entry, uid: process.getuid(), dev: 1, ino: ++inode, nlink: 1 });
  };
  const stat = (node) => ({ ...node, isFile: () => node.kind === 'file',
    isDirectory: () => node.kind === 'directory', isSymbolicLink: () => false });
  for (const file of ['/', path.dirname(sourceConfig)]) add(file, { kind: 'directory', mode: 0o700 });
  add(sourceConfig, { kind: 'file', mode: 0o600, bytes: source });
  const io = {
    lstatSync(file) { return stat(nodeAt(file)); },
    realpathSync(file) { nodeAt(file); return file; },
    fstatSync(fd) { return stat(handleAt(fd).node); },
    openSync(file, flags, mode) {
      opens.push(file);
      const writing = flags === (constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW);
      if (writing) {
        if (nodeAt(path.dirname(file)).kind !== 'directory') throw failure('ENOTDIR');
        add(file, { kind: 'file', mode, bytes: '' });
        mutations.push(['create', file]);
      } else assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW);
      const node = nodeAt(file);
      assert.equal(node.kind, 'file');
      const fd = descriptor++;
      descriptors.set(fd, { file, node, writing });
      return fd;
    },
    readFileSync(file, encoding) {
      assert.equal(encoding, 'utf8');
      const handle = typeof file === 'number' ? handleAt(file) : { file, node: nodeAt(file) };
      reads.push(handle.file);
      assert.equal(handle.node.kind, 'file');
      return handle.node.bytes;
    },
    writeFileSync(fd, bytes) {
      const handle = handleAt(fd);
      if (!handle.writing) throw failure('EBADF');
      handle.node.bytes = String(bytes);
      mutations.push(['write', handle.file]);
    },
    closeSync(fd) { handleAt(fd); descriptors.delete(fd); },
    mkdirSync(file, options) {
      if (nodeAt(path.dirname(file)).kind !== 'directory') throw failure('ENOTDIR');
      add(file, { kind: 'directory', mode: options.mode });
      mutations.push(['mkdir', file]);
    },
    readdirSync(file) {
      if (nodeAt(file).kind !== 'directory') throw failure('ENOTDIR');
      return [...nodes.keys()].filter((key) => key !== file && path.dirname(key) === file).map((key) => path.basename(key));
    },
    unlinkSync(file) {
      assert.equal(nodeAt(file).kind, 'file');
      nodes.delete(file); mutations.push(['unlink', file]);
    },
    rmdirSync(file) {
      if (io.readdirSync(file).length) throw failure('ENOTEMPTY');
      nodes.delete(file); mutations.push(['rmdir', file]);
    },
  };
  return { io, nodes, descriptors, opens, reads, mutations };
}

module.exports = { metadataMemoryIO };
