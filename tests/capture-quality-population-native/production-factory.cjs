const { requireStage } = require('./value.cjs');

async function productionFactory(input, options) {
  requireStage(typeof options.invoke === 'function', 'explicit_production_invoke_required');
  const { captureExecutionProfile } = await import('../../plugin/capture/execution-profile.js');
  const execution = captureExecutionProfile(options.captureExecutionMs, options.maintenanceExecutionMs);
  const [captureModule, commandsModule, maintenanceModule, operationsModule, organizationModule, policyModule, recallModule, hooksModule] = await Promise.all([
    import('../../plugin/capture/index.js'), import('../../plugin/commands.js'), import('../../plugin/maintenance/runtime.js'),
    import('../../plugin/operations.js'), import('../../plugin/organization.js'), import('../../plugin/policy.js'),
    import('../../plugin/recall.js'), import('../../plugin/hooks.js'),
  ]);
  const policy = policyModule.loadPolicy(options);
  const runtime = recallModule.createRecallRuntime(input, options, options.invoke);
  const organization = organizationModule.createOrganization(runtime, policy, options.invoke);
  const operations = { ...operationsModule.createOperations(runtime), organization: { ...organization,
    permitted(args, context) {
      requireStage(args.operation !== 'apply', 'quality_organization_apply_forbidden');
      return organization.permitted(args, context);
    } } };
  const commands = commandsModule.createCommands(operations, runtime, policy.provenance);
  const maintenance = maintenanceModule.createMaintenance({ ...input, captureExecutionMs: execution.capture_ms, maintenanceExecutionMs: execution.maintenance_ms, maintenanceObservation: options.maintenanceObservation }, runtime, { invoke: options.invoke });
  const capture = captureModule.createCapture({ ...input, captureExecutionMs: execution.capture_ms, maintenanceExecutionMs: execution.maintenance_ms, captureObservation: options.captureObservation,
    captureCoordinator: maintenance.coordinator }, runtime, operations);
  return hooksModule.composeHooks({ runtime, operations, commands, maintenance, capture, policy });
}
module.exports = { productionFactory };
