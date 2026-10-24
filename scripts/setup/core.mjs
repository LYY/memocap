import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { commands, packageName, parseArguments, SetupError } from "./arguments.mjs";
import { backendReadiness, backendStatus, backendWarnings } from "./backend.mjs";
import { configScopes, pluginSource } from "./config.mjs";
import { readJSON, readText } from "./files.mjs";
import { verifyHost } from "./host.mjs";
import { appendPendingSteps, inspectScopes, mutateInstall, mutateUninstall, preflight, scopeReports } from "./lifecycle.mjs";
import { loadManifest } from "./manifest.mjs";
import { discoverCLI, prerequisites, refuseDowngrade, resolveVersion } from "./packages.mjs";
import { installationPlan } from "./plan.mjs";
import { runProcess } from "./process.mjs";
import { delegateWorker, sharedImpact } from "./update.mjs";

function runtimeDefaults() {
  return { env: process.env, cwd: process.cwd(), packageRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), run: runProcess, platform: process.platform, arch: process.arch };
}

function initialReport() {
  return { format_version: 1, operation_id: randomUUID(), operation: null, status: "not_run", exit_code: 1, started_at: new Date().toISOString(), elapsed_ms: 0,
    runner_version: null, resolved_version: null, update_available: null, repair_required: null, scopes: [], steps: [], backups: [], warnings: [], error: null,
    restart_required: false, readiness: "not_run", runtime: { status: "not_run", reason: "Open a new OpenCode session and verify /memory status and recall receipts" },
    commands: commands, command_registration: "The plugin registers /memory after OpenCode loads it", bootstrap: { npx_may_download_before_core: true },
    recovery: { retry: null, note: "Read actual component state before repeating an uncertain write; rerun the same --to to complete missing steps" } };
}

function refreshReadback(context) {
  context.scopes = context.scopes.map((scope) => ({ ...scope, text: readText(scope.config) }));
  const inspections = inspectScopes(context);
  context.report.scopes = scopeReports(inspections, context.target);
  componentAvailability(context, inspections);
}

function componentAvailability(context, inspections) {
  const { report, target } = context;
  const versions = [report.shared_cli.version, ...inspections.flatMap(({ plugin, skill }) => [
    ...plugin.entries.map((entry) => pluginSource(entry).slice(`${packageName}@`.length)), skill.lock.entry?.ref?.replace(/^v/, ""),
  ])].filter(Boolean);
  report.update_available = versions.some((version) => version !== target);
  report.repair_required = !report.shared_cli.version || !report.shared_cli.executable_path || inspections.some(({ plugin, skill }) =>
    plugin.entries.length !== 1 || pluginSource(plugin.entries[0]) !== `${packageName}@${target}` || !skill.selected?.discovery_path || (skill.lock.entry?.ref !== `v${target}` && skill.lock.entry?.sourceUrl !== `https://github.com/LYY/memocap/tree/v${target}`));
}

async function inspectCurrentState(context) {
  const { options, report, runtime } = context;
  if (options.command !== "uninstall") report.prerequisites = await prerequisites(runtime);
  context.scopes = configScopes(options, runtime);
  const loaded = loadManifest(runtime);
  context.manifest = loaded.manifest;
  context.manifestPath = loaded.filename;
  context.manifestText = loaded.text;
  report.manifest_path = loaded.filename;
  report.shared_cli = await discoverCLI(runtime, options);
  const inspections = inspectScopes(context);
  report.scopes = scopeReports(inspections, context.target);
  if (options.command !== "uninstall") await backendStatus(context);
  report.plan = installationPlan(context, inspections);
  componentAvailability(context, inspections);
  return inspections;
}

function checkComponentVersions(context, inspections) {
  if (context.options.command === "uninstall") return;
  refuseDowngrade(context.report.shared_cli.version, context.target);
  for (const { plugin, skill } of inspections) {
    for (const entry of plugin.entries) { const version = pluginSource(entry).slice(`${packageName}@`.length); if (version) refuseDowngrade(version, context.target); }
    if (skill.lock.entry?.ref) refuseDowngrade(skill.lock.entry.ref.replace(/^v/, ""), context.target);
  }
}

function readOnlyResult(context, inspections) {
  const { options, report, target } = context;
  if (!["check", "doctor"].includes(options.command)) return false;
  preflight(context, inspections);
  backendWarnings(report);
  if (options.command === "check") { report.status = "ok"; report.readiness = backendReadiness(report); report.exit_code = 0; return true; }
  const complete = report.prerequisites.opencode === "1.19.3" && report.shared_cli.version === target && report.shared_cli.executable_path && report.shared_cli.cache.status === "verified" && inspections.every(({ plugin, skill }) => !plugin.conflicts.length && plugin.entries.length === 1 && skill.selected?.discovery_path && skill.lock.entry?.ref === `v${target}`);
  const readiness = backendReadiness(report);
  report.status = !complete && readiness === "static_ready" ? "incomplete" : readiness;
  report.readiness = report.status;
  report.exit_code = report.status === "static_ready" ? 0 : 1;
  return true;
}

async function executePlan(context, inspections) {
  const { options, report, runtime } = context;
  if (options.command !== "uninstall") sharedImpact(context);
  preflight(context, inspections);
  if (options.dryRun) { report.status = "planned"; report.exit_code = 0; report.dry_run = true; if (options.command !== "uninstall") report.readiness = backendReadiness(report); return; }
  if (!options.yes) throw new SetupError("confirmation_required", "Review --dry-run, then pass --yes to execute the declared scopes");
  if (options.command !== "uninstall") report.prerequisites.opencode = await verifyHost(runtime, report.prerequisites.host);
  if (options.command === "uninstall") await mutateUninstall(context, inspections);
  else await mutateInstall(context, inspections);
  refreshReadback(context);
  report.status = report.steps.some((entry) => entry.status === "changed") ? "changed" : "unchanged";
  report.restart_required = report.status === "changed";
  if (options.command !== "uninstall") backendWarnings(report);
  report.readiness = options.command === "uninstall" ? "removed" : backendReadiness(report);
  report.exit_code = ["removed", "static_ready"].includes(report.readiness) ? 0 : 1;
}

function reportFailure(context, error) {
  const { report } = context;
  report.error = { code: error.code || "setup_failed", message: error.message, details: error.details || null };
  report.status = report.steps.some((entry) => entry.status === "changed" || entry.mutation_status === "changed") ? "partial" : "failed";
  report.restart_required = report.status === "partial";
  report.exit_code = 1;
  appendPendingSteps(context);
  if (context.manifest && context.scopes.length) {
    try { refreshReadback(context); }
    catch (readbackError) { report.warnings.push({ code: "readback_failed", message: readbackError.message }); }
  }
}

export async function runSetup(argv, overrides = {}) {
  const runtime = { ...runtimeDefaults(), ...overrides };
  const report = initialReport();
  const context = { runtime, report, scopes: [] };
  const started = Date.now();
  try {
    context.options = parseArguments(argv, runtime.cwd);
    report.operation = context.options.command;
    const metadata = readJSON(path.join(runtime.packageRoot, "package.json"));
    if (metadata?.name !== packageName || typeof metadata.version !== "string") throw new SetupError("runner_identity", "Invalid setup package identity");
    report.runner_version = metadata.version;
    if (context.options.help) return { ...report, status: "ok", exit_code: 0, usage: "memocap-setup <install|check|update|doctor|uninstall> [--global] [--project PATH ...] [--config FILE] [--to VERSION] [--package-manager npm|pnpm] [--yes] [--dry-run] [--remove-cli] [--json]" };
    if (context.options.worker && context.options.to !== metadata.version) throw new SetupError("worker_version_mismatch", `Worker ${metadata.version} cannot mutate target ${context.options.to}`);
    context.target = await resolveVersion(context.options, runtime, metadata.version);
    report.resolved_version = context.target;
    report.recovery.retry = ["memocap-setup", context.options.command, "--to", context.target, ...(context.options.global ? ["--global"] : []), ...context.options.projects.flatMap((project) => ["--project", project]), ...(context.options.config ? ["--config", context.options.config] : []), "--yes", "--json"];
    const writes = ["install", "update", "uninstall"].includes(context.options.command) && !context.options.dryRun;
    if (writes && context.options.yes && context.options.command !== "uninstall" && context.target !== metadata.version) return await delegateWorker(argv, context);
    const inspections = await inspectCurrentState(context);
    checkComponentVersions(context, inspections);
    if (!readOnlyResult(context, inspections)) await executePlan(context, inspections);
  } catch (error) {
    reportFailure(context, error);
  } finally { report.elapsed_ms = Date.now() - started; }
  return report;
}
