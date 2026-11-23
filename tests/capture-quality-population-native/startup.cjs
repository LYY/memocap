const fs = require('node:fs');
const path = require('node:path');
const { managedPaths } = require('../capture-quality-native/preload-decision.cjs');
const { requireStage } = require('./value.cjs');

function recheckStartup(preparation, paths) {
  const proof = preparation.recheck();
  requireStage(proof?.kind === 'owned-preload-v1' && proof.private_root === path.dirname(paths.home) &&
    proof.home === paths.home && proof.config === paths.config && proof.write_access === 'W_OK_denied' &&
    JSON.stringify(proof.directories) === JSON.stringify([path.join(paths.config, 'opencode'), paths.config]), 'preload_preparation_required');
  requireStage(!managedPaths.some((file) => fs.existsSync(file)), 'preload_managed_source_present');
}
module.exports = { recheckStartup };
