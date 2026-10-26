import { packageName } from "./arguments.mjs";
import { pluginSource } from "./config.mjs";
import { cliInstallArguments } from "./packages.mjs";
import { targetPolicy } from "./skills.mjs";

function plannedPolicy(scope, context) {
  const owned = context.manifest.installs[scope.id]?.skill;
  if (context.options.command === "uninstall" && owned?.kind === "managed") return { kind: "managed", version: owned.version, source_version: owned.source_version, digest: owned.digest, path: owned.path, mainPath: owned.mainPath, payload_root: owned.payload_root, owned_paths: owned.owned_paths, source_status: "installed_owner" };
  if (context.target !== context.report.runner_version) return { kind: "managed", version: context.target, source_version: null, digest: null, path: null, mainPath: null, payload_root: null, owned_paths: [], source_status: "target_worker_required" };
  return { ...targetPolicy(scope, context), source_status: "verified_runner_bundle" };
}

export function installationPlan(context, inspections) {
  const { options, report, target } = context;
  const uninstall = options.command === "uninstall";
  return {
    cli: { scope: "current_user_shared", manager: report.shared_cli.manager, current_version: report.shared_cli.version, target_version: target,
      action: uninstall ? options.removeCLI ? "remove_if_unreferenced" : "preserve" : report.shared_cli.version === target && report.shared_cli.executable_path ? "reuse_and_verify" : "install",
      command: uninstall ? null : { executable: report.shared_cli.manager, args: cliInstallArguments(report.shared_cli.manager, target) } },
    scopes: inspections.map(({ scope, plugin, skill, owner_id, owner_reused, owner }) => ({ id: scope.id, kind: scope.kind, directory: scope.directory, owner_id, owner_reused,
      plugin: { config: owner_reused ? owner.scope.config : scope.config, action: owner_reused ? "reuse_owner" : uninstall ? "remove_unmodified_owned_entry" : "set_owned_entry", pin: uninstall ? pluginSource(plugin.entries[0]) || null : `${packageName}@${target}` },
      skill: { action: owner_reused ? "reuse_owner" : uninstall ? "remove_unreferenced_owned_payload" : "copy_bundle_then_switch_config", ...plannedPolicy(owner_reused ? owner.scope : scope, context), command: null, migration: skill.migration || null, checked_roots: skill.roots },
      automatic_recall: { enabled: !uninstall && !(Array.isArray(plugin.entries[0]) && plugin.entries[0][1]?.automatic === false), effects: ["read_core_memory", "write_main_activity", "prune_main_activity", "configured_remote_requests"] } })),
    database_action: uninstall ? "preserve" : report.backend?.backend === "remote" ? "server_admin_only" : "prepare_main_schema_2_compatible",
    main_preparation: uninstall ? "preserve" : report.backend?.backend === "remote" ? "server_admin_only" : "prepare_missing_or_legacy_after_prerequisites", runtime_verification: "not_run", unknown_shared_consumers: "not_enumerated", uninspected_projects: "other_and_future_cwd_not_inspected",
  };
}
