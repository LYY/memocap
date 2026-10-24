import fs from "node:fs";
import path from "node:path";
import { compareVersions, SetupError } from "./arguments.mjs";
import { launcherScript } from "./process.mjs";

const capabilities = ["receipt_v1", "recall_match", "multi_target", "inventory", "activity", "read_only_status", "single_database", "schema_2_compatible"];

function inspectionExecutable(context) {
  const cli = context.report.shared_cli;
  if (!cli.executable_path) return null;
  const launcher = path.join(cli.package_root, "bin/cli.cjs");
  if (fs.existsSync(launcher)) {
    const script = launcherScript(cli.executable_path);
    if (!script || fs.realpathSync(script) !== fs.realpathSync(launcher)) {
      throw new SetupError("cli_path_mismatch", "PATH executable is not the installed package launcher");
    }
    return cli.cache.status === "verified" ? cli.cache.binary : null;
  }
  return cli.executable_path;
}

function receiptJSON(execution) {
  try { return JSON.parse(execution.stdout); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SetupError("backend_receipt_invalid", "Backend did not return a JSON receipt");
  }
}

function validateInspection(receipt, status) {
  const inspection = receipt?.inspection;
  if (receipt?.format_version !== 1 || receipt.status !== "ok" || receipt.backend !== status.backend || !inspection ||
      receipt.origin !== (status.backend === "local" ? "cli" : "server") ||
      (inspection.activity_error !== null && typeof inspection.activity_error !== "string") ||
      (inspection.activity_status === "degraded" ? !inspection.activity_error : inspection.activity_error !== null) ||
      !Array.isArray(inspection.capabilities) || inspection.capabilities.some((name) => typeof name !== "string") ||
      !validInspectionContract(inspection, status.binary_contract)) {
    throw new SetupError("backend_incompatible", "Backend inspection does not satisfy the single-database contract");
  }
  return inspection;
}

function validInspectionContract(inspection, contract) {
  switch (contract) {
    case "released_schema_1": return validReleasedState(inspection) && capabilities.slice(0, -2).every((name) => inspection.capabilities.includes(name));
    case "single_database": return validSchemaState(inspection) && capabilities.every((name) => inspection.capabilities.includes(name));
    default: return false;
  }
}

function validReleasedState(inspection) {
  if (!["ready", "not_initialized", "degraded"].includes(inspection.activity_status)) return false;
  switch (inspection.core_status) {
    case "not_initialized": return inspection.schema_version === null && inspection.visible === null;
    case "ready": return inspection.schema_version === "1.0" && validVisible(inspection);
    default: return false;
  }
}

function validVisible(inspection) {
  const visible = inspection.visible;
  return visible?.schema_version === inspection.schema_version && Array.isArray(visible.placements) &&
    Number.isSafeInteger(visible.addressable_total) && visible.addressable_total >= 0 &&
    Number.isSafeInteger(visible.effective_total) && visible.effective_total >= 0 && visible.effective_total <= visible.addressable_total;
}

function validSchemaState(inspection) {
  switch (inspection.core_status) {
    case "not_initialized":
      return inspection.schema_version === null && inspection.visible === null && inspection.activity_status === "not_initialized";
    case "upgrade_needed":
      return inspection.schema_version === "1.0" && inspection.visible === null && inspection.activity_status === "upgrade_needed";
    case "ready": {
      return typeof inspection.schema_version === "string" && /^2\.(0|[1-9]\d*)$/.test(inspection.schema_version) &&
        validVisible(inspection) &&
        ["ready", "degraded"].includes(inspection.activity_status);
    }
    default: return false;
  }
}

export async function backendStatus(context) {
  const { runtime, report } = context;
  const database = runtime.env.MEMOCAP_DB || path.join(runtime.env.HOME || runtime.env.USERPROFILE, ".memocap/memocap.db");
  const backend = runtime.env.MEMOCAP_ADDR ? "remote" : "local";
  const executable = inspectionExecutable(context);
  const status = { backend, database: backend === "local" ? path.resolve(runtime.cwd, database) : null,
    status: "not_run", core_schema: { expected: "2.0", status: "not_run" }, activity: { status: "not_run" },
    remote_capabilities: { status: "not_run" }, database_preserved: true, executable_path: executable,
    reason: executable ? null : "cli_unavailable_without_cache_warmup" };
  report.backend = status;
  if (!executable) return status;
  try {
    await verifyExecutable(context, executable);
    if (backend === "local" && report.shared_cli.version === "0.0.10" && typeof context.target === "string" && compareVersions(context.target, "0.0.10") > 0) {
      status.status = "deferred";
      status.reason = "legacy_inspection_unavailable_until_target_install";
      return status;
    }
    await inspectBackend(context, status);
  } catch (error) { status.status = "failed"; throw error; }
  return status;
}

async function verifyExecutable(context, executable) {
  const { runtime, report } = context;
  const version = await runtime.run(executable, ["--version"], { env: runtime.env, cwd: runtime.cwd });
  if (version.code !== 0 || ![`memocap ${report.shared_cli.version}`, report.shared_cli.version].includes(version.stdout.trim())) {
    throw new SetupError("cli_version_mismatch", "Resolved backend executable does not match the installed package");
  }
  report.shared_cli.executable_version = version.stdout.trim().replace(/^memocap /, "");
}

async function inspectBackend(context, status) {
  const { runtime } = context;
  const execution = await runtime.run(status.executable_path, ["status", "--read-only", "--json"], { env: runtime.env, cwd: runtime.cwd });
  const receipt = receiptJSON(execution);
  if (execution.code !== 0) throw new SetupError("backend_inspection_failed", "Backend read-only inspection failed", { backend_code: receipt?.error?.code || null });
  const legacy = status.backend === "local" && context.report.shared_cli.version === "0.1.0" && typeof context.target === "string" &&
    compareVersions(context.target, "0.1.0") > 0 && Array.isArray(receipt?.inspection?.capabilities) &&
    capabilities.slice(-2).every((name) => !receipt.inspection.capabilities.includes(name));
  status.binary_contract = legacy ? "released_schema_1" : "single_database";
  const observed = validateInspection(receipt, status);
  const inspection = legacy ? { ...observed, core_status: observed.schema_version === "1.0" ? "upgrade_needed" : "not_initialized",
    visible: null, activity_status: observed.schema_version === "1.0" ? "upgrade_needed" : "not_initialized", activity_error: null } : observed;
  const token = runtime.env.MEMOCAP_TOKEN;
  if (token && inspection.activity_error) inspection.activity_error = inspection.activity_error.replaceAll(token, "[redacted]");
  Object.assign(status, { status: "ok", origin: receipt.origin, inspection,
      core_schema: { expected: "2.0", observed: inspection.schema_version, status: inspection.core_status === "ready" ? "compatible" : inspection.core_status },
      memory_status: inspection.core_status, activity: { status: inspection.activity_status, error: inspection.activity_error },
      remote_capabilities: { status: status.backend === "remote" ? "compatible" : "not_applicable", capabilities: inspection.capabilities } });
}

export function backendReadiness(report) {
  const backend = report.backend;
  if (backend.status === "deferred") return "inspection_deferred";
  if (backend.status !== "ok") return "incomplete";
  if (backend.memory_status !== "ready") return backend.memory_status;
  if (backend.activity.status !== "ready") return `activity_${backend.activity.status}`;
  return report.repair_required || report.update_available ? "incomplete" : "static_ready";
}

export function backendWarnings(report) {
  const backend = report.backend;
  if (backend.activity.status === "degraded") report.warnings.push({ code: "activity_degraded", message: backend.activity.error });
  if (backend.backend === "remote" && ["not_initialized", "upgrade_needed"].includes(backend.memory_status)) report.warnings.push({ code: "server_admin_required", message: "The server administrator must prepare the main database locally" });
  if (backend.memory_status === "not_initialized") report.warnings.push({ code: "memory_not_initialized", message: "The main database requires explicit installation preparation" });
  if (backend.memory_status === "upgrade_needed") report.warnings.push({ code: "upgrade_needed", message: "The observed schema 1.0 requires explicit installation preparation" });
}

export async function prepareBackend(context) {
  await backendStatus(context);
  const { report, runtime } = context;
  if (report.backend.status !== "ok") throw new SetupError("backend_unavailable", "Cannot inspect the installed backend");
  if (report.backend.backend !== "local" || !["not_initialized", "upgrade_needed"].includes(report.backend.activity.status)) return { status: "unchanged" };
  context.manifest.backend = { status: "outcome_unknown", operation: "activity_prepare", database: report.backend.database };
  let execution;
  let executionError;
  try { execution = await runtime.run(report.backend.executable_path, ["activity", "prepare", "--json"], { env: runtime.env, cwd: runtime.cwd }); }
  catch (error) { executionError = error; }
  try { await backendStatus(context); }
  catch (error) { throw new SetupError("activity_outcome_unknown", "Main database preparation readback failed; inspect storage before retrying", { readback_code: error.code || null }); }
  if (report.backend.memory_status !== "ready" || report.backend.activity.status !== "ready") throw new SetupError(executionError || execution.code ? "activity_outcome_unknown" : "activity_readback_failed", "Main database preparation was not verified; inspect storage before retrying");
  context.manifest.backend = { status: "ready", operation: "activity_prepare", database: report.backend.database };
  return { status: "changed", recovered_after_error: Boolean(executionError) || execution.code !== 0 };
}
