import { CaptureStop } from './contract.js';

const profiles = new Map([30000, 45000, 60000].flatMap((capture_ms) => [30000, 45000, 60000].map((maintenance_ms) => [`${capture_ms}/${maintenance_ms}`, Object.freeze({
  id: `capture-${capture_ms}ms${maintenance_ms === 30000 ? '' : `-maintenance-${maintenance_ms}ms`}`, capture_ms, maintenance_ms, provider_request_ms: 30000,
  terminal_pad_ms: 3000, outer_pad_ms: 3000,
})])));

export function captureExecutionProfile(milliseconds = 30000, maintenanceExecutionMs = 30000) {
  if (![30000, 45000, 60000].includes(maintenanceExecutionMs)) throw new CaptureStop('maintenance_execution_profile', 'failed');
  const profile = [30000, 45000, 60000].includes(milliseconds) && profiles.get(`${milliseconds}/${maintenanceExecutionMs}`);
  if (!profile) throw new CaptureStop('capture_execution_profile', 'failed');
  return profile;
}

export function captureCollectionWindow(profile, maintenance = false) {
  const execution = profile.capture_ms + (maintenance ? profile.maintenance_ms : 0);
  return Object.freeze({ execution_ms: execution, inner_ms: execution + profile.terminal_pad_ms,
    outer_ms: execution + profile.terminal_pad_ms + profile.outer_pad_ms });
}
