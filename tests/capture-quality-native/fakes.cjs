const { EventEmitter } = require('node:events');

function memoryIO() {
  const files = new Map();
  return { files, existsSync: (name) => files.has(name),
    mkdirSync(name) { if (files.has(name)) throw Object.assign(new Error(), { code: 'EEXIST' }); files.set(name, ''); },
    readFileSync(name) { if (!files.has(name)) throw Object.assign(new Error(), { code: 'ENOENT' }); return files.get(name); },
    writeFileSync(name, value, options) {
      if (options?.flag === 'wx' && files.has(name)) throw Object.assign(new Error(), { code: 'EEXIST' });
      files.set(name, String(value));
    }, renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    rmdirSync: (name) => files.delete(name),
    rmSync(name) { for (const key of files.keys()) if (key === name || key.startsWith(`${name}/`)) files.delete(key); } };
}

function processFake(log) {
  return (binary, args, options) => {
    log.push({ binary, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = (signal) => { log.push(signal); queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); }); };
    queueMicrotask(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:8123'));
    return child;
  };
}

module.exports = { memoryIO, processFake };
