const fs = require('node:fs');
const path = require('node:path');
const { requireStage, size } = require('./value.cjs');
const { prepareOwnedPreload } = require('../capture-quality-native/preload-preparation.cjs');

function owned(root) {
  requireStage(path.isAbsolute(root) && path.resolve(root) === root && root !== path.parse(root).root && !fs.existsSync(root), 'owned_root_required');
  fs.mkdirSync(root, { mode: 0o700 });
  const identity = fs.lstatSync(root);
  const paths = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'tmp', 'project'].map((name) => [name, path.join(root, name)]));
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { mode: 0o700 });
  paths.database = path.join(root, 'memory.sqlite');
  paths.socket = path.join(root, 'control.sock');
  paths.settings = path.join(root, 'settings.json');
  const preparation = prepareOwnedPreload(root, paths);
  function check() {
    const current = fs.lstatSync(root);
    requireStage(current.ino === identity.ino && current.dev === identity.dev && current.uid === identity.uid &&
      !current.isSymbolicLink() && fs.realpathSync(root) === root, 'owned_identity_changed');
  }
  function materialize(translation) {
    check();
    requireStage(translation.files.length <= 2, 'carrier_file_budget');
    for (const file of translation.files) {
      requireStage(path.dirname(file.path) === paths.project && /^[a-f0-9-]{36}\.(data|cjs)$/.test(path.basename(file.path)) &&
        typeof file.bytes === 'string' && size(file.bytes) <= 16384, 'carrier_private_path');
      fs.writeFileSync(file.path, file.bytes, { flag: 'wx', mode: 0o600 });
    }
  }
  return { paths, preparation, materialize,
    close({ exited, retain_recovery }) {
      check();
      if (exited !== true || retain_recovery) return { exited, removed: false, recovery_root: root };
      preparation.restore(); fs.rmSync(root, { recursive: true });
      return { exited: true, removed: true };
    } };
}
module.exports = { owned };
