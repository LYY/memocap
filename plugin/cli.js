import { captureExecutionProfile } from './capture/execution-profile.js';
import { createCapture } from "./capture/index.js";
import { createCommands } from "./commands.js";
import { composeHooks } from "./hooks.js";
import { createMaintenance } from "./maintenance/runtime.js";
import { createOperations } from "./operations.js";
import { createOrganization } from "./organization.js";
import { loadPolicy } from "./policy.js";
import { createRecallRuntime } from "./recall.js";

export async function memocap(input, options = {}) {
  const profile = captureExecutionProfile(
    options.captureExecutionMs === undefined ? 60000 : options.captureExecutionMs,
    options.maintenanceExecutionMs === undefined ? 60000 : options.maintenanceExecutionMs,
  );
  const policy = loadPolicy(options);
  const runtime = createRecallRuntime(input, options);
  const operations = { ...createOperations(runtime), organization: createOrganization(runtime, policy) };
  const commands = createCommands(operations, runtime, policy.provenance);
  const maintenance = createMaintenance({ ...input, captureExecutionMs: profile.capture_ms, maintenanceExecutionMs: profile.maintenance_ms, maintenanceObservation: options.maintenanceObservation }, runtime);
  const capture = createCapture({ ...input, captureExecutionMs: profile.capture_ms, maintenanceExecutionMs: profile.maintenance_ms, captureObservation: options.captureObservation, captureCoordinator: maintenance.coordinator }, runtime, operations);
  return composeHooks({ runtime, operations, commands, maintenance, capture, policy });
}
