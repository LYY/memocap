const { captureExecutionProfile, captureCollectionWindow } = require('../../plugin/capture/execution-profile.js');
const { requireStage } = require('./value.cjs');
const { isDeepStrictEqual } = require('node:util');

function executionProfile(input, milliseconds, maintenanceExecutionMs) {
  const descriptor = input?.descriptor ?? (input?.kind === 'finite-evaluation-v1' ? input : undefined);
  const declared = captureExecutionProfile(descriptor?.captureExecutionMs, descriptor?.maintenanceExecutionMs);
  const selected = captureExecutionProfile(milliseconds === undefined ? declared.capture_ms : milliseconds,
    maintenanceExecutionMs === undefined ? declared.maintenance_ms : maintenanceExecutionMs);
  requireStage(!descriptor || selected === declared, 'capture_execution_profile_mismatch');
  return selected;
}
function bindExecutionProfile(input, grant, selected) {
  const profile = executionProfile(selected, Object.hasOwn(input, 'captureExecutionMs') ? input.captureExecutionMs : undefined,
    Object.hasOwn(input, 'maintenanceExecutionMs') ? input.maintenanceExecutionMs : undefined);
  requireStage(profile === captureExecutionProfile(grant.captureExecutionMs, grant.maintenanceExecutionMs), 'capture_execution_profile_mismatch');
  return profile;
}
function assertExecutionProfile(value, profile) {
  requireStage(isDeepStrictEqual(value, profile), 'capture_execution_profile_mismatch');
}
module.exports = { executionProfile, bindExecutionProfile, captureCollectionWindow, assertExecutionProfile };
