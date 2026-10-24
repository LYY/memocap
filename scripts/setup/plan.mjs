import { packageName } from "./arguments.mjs";
import { cliInstallArguments } from "./packages.mjs";
import { skillInstallArguments } from "./skills.mjs";

export function installationPlan(context, inspections) {
  const { options, report, target } = context;
  const uninstall = options.command === "uninstall";
  return {
    cli: { scope: "current_user_shared", manager: report.shared_cli.manager, current_version: report.shared_cli.version, target_version: target,
      action: uninstall ? options.removeCLI ? "remove_if_unreferenced" : "preserve" : report.shared_cli.version === target && report.shared_cli.executable_path ? "reuse_and_verify" : "install",
      command: uninstall ? null : { executable: report.shared_cli.manager, args: cliInstallArguments(report.shared_cli.manager, target) } },
    scopes: inspections.map(({ scope, plugin }) => ({ id: scope.id, kind: scope.kind, directory: scope.directory,
      plugin: { config: scope.config, action: uninstall ? "remove_unmodified_owned_entry" : "set_owned_entry", pin: `${packageName}@${target}` },
      skill: { action: uninstall ? "remove_unmodified_unshared_reference" : "install_or_reuse_matching_release", source: `https://github.com/LYY/memocap/tree/v${target}`,
        command: uninstall ? null : { executable: "npx", args: skillInstallArguments(scope, target), cwd: scope.directory } },
      automatic_recall: { enabled: !uninstall && !(Array.isArray(plugin.entries[0]) && plugin.entries[0][1]?.automatic === false), effects: ["read_core_memory", "write_main_activity", "prune_main_activity", "configured_remote_requests"] } })),
    database_action: uninstall ? "preserve" : report.backend?.backend === "remote" ? "server_admin_only" : "prepare_main_schema_2_compatible",
    main_preparation: uninstall ? "preserve" : report.backend?.backend === "remote" ? "server_admin_only" : "prepare_missing_or_legacy_after_prerequisites", runtime_verification: "not_run",
    unknown_shared_consumers: "not_enumerated",
  };
}
