const fs = require('node:fs');
const path = require('node:path');
const { CanaryBlocked } = require('./entry.cjs');

function prepareOwnedPreload(privateRoot, paths, io = fs) {
  if (typeof privateRoot !== 'string' || !path.isAbsolute(privateRoot) ||
      path.resolve(privateRoot) !== privateRoot || privateRoot === path.parse(privateRoot).root ||
      paths.home !== path.join(privateRoot, 'home') || paths.config !== path.join(privateRoot, 'config')) {
    throw new CanaryBlocked('preload_owned_layout_required');
  }
  const privateDirectories = ['data', 'cache', 'state', 'tmp', 'project'].filter((name) => paths[name] !== undefined);
  if (privateDirectories.some((name) => paths[name] !== path.join(privateRoot, name))) {
    throw new CanaryBlocked('preload_owned_layout_required');
  }
  const originals = [privateRoot, paths.home, paths.config, ...privateDirectories.map((name) => paths[name])].map((directory) => {
    const stat = io.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
        (stat.mode & 0o777) !== 0o700 || io.realpathSync(directory) !== directory) {
      throw new CanaryBlocked('preload_owned_layout_required');
    }
    return { directory, stat };
  });
  if (io.readdirSync(paths.home).length || io.readdirSync(paths.config).length) {
    throw new CanaryBlocked('preload_owned_layout_required');
  }
  const globalConfig = path.join(paths.config, 'opencode');
  io.mkdirSync(globalConfig, { mode: 0o700 });
  const directories = Object.freeze([globalConfig, paths.config]);
  const owned = [...originals, { directory: globalConfig, stat: io.lstatSync(globalConfig) }];
  const changed = [];
  const identity = () => {
    for (const { directory, stat } of owned) {
      const current = io.lstatSync(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== stat.uid ||
          current.dev !== stat.dev || current.ino !== stat.ino || io.realpathSync(directory) !== directory) {
        throw new CanaryBlocked('preload_owned_identity_changed');
      }
    }
  };
  const restore = () => {
    identity();
    for (const { directory, stat } of [...changed].reverse()) io.chmodSync(directory, stat.mode & 0o7777);
    changed.length = 0;
  };
  const ignored = ['node_modules', 'package.json', 'package-lock.json', 'bun.lock', '.gitignore'].join('\n');
  const recheck = () => {
    identity();
    if (io.readdirSync(paths.home).length || (paths.project && ['.opencode', 'opencode.json', 'opencode.jsonc']
      .some((name) => io.existsSync(path.join(paths.project, name))))) throw new CanaryBlocked('preload_discovery_changed');
    for (const { directory } of owned) {
      if ((io.lstatSync(directory).mode & 0o777) !== (directories.includes(directory) ? 0o500 : 0o700)) {
        throw new CanaryBlocked('preload_owned_layout_required');
      }
    }
    for (const directory of directories) {
      const entries = io.readdirSync(directory).sort();
      const expected = directory === paths.config ? ['.gitignore', 'opencode'] : ['.gitignore'];
      const ignore = path.join(directory, '.gitignore');
      const stat = io.lstatSync(ignore);
      if (JSON.stringify(entries) !== JSON.stringify(expected) || !stat.isFile() || stat.isSymbolicLink()
        || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || io.readFileSync(ignore, 'utf8') !== ignored) {
        throw new CanaryBlocked('preload_discovery_changed');
      }
      let refused = false;
      try { io.accessSync(directory, fs.constants.W_OK); }
      catch (error) {
        if (!(error instanceof Error) || !['EACCES', 'EPERM'].includes(error.code)) throw error;
        refused = true;
      }
      if (!refused) throw new CanaryBlocked('preload_config_still_writable');
    }
    return Object.freeze({ kind: 'owned-preload-v1', private_root: privateRoot, home: paths.home, config: paths.config,
      directories, write_access: 'W_OK_denied' });
  };
  try {
    for (const directory of directories) {
      io.writeFileSync(path.join(directory, '.gitignore'), ignored, { flag: 'wx', mode: 0o600 });
    }
    for (const directory of directories) {
      const original = owned.find((item) => item.directory === directory);
      changed.push(original);
      io.chmodSync(directory, original.stat.mode & 0o555);
    }
    recheck();
    return Object.freeze({ directories, restore, recheck });
  } catch (error) {
    try { restore(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'preload preparation and restoration failed'); }
    throw error;
  }
}

module.exports = { prepareOwnedPreload };
