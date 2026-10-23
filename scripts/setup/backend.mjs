import fs from "node:fs";
import path from "node:path";
import { SetupError } from "./arguments.mjs";
import { windowsShimScript } from "./process.mjs";

const capabilities = ["receipt_v1", "recall_match", "multi_target", "inventory", "activity", "read_only_status"];

function inspectionExecutable(context) {
  const cli = context.report.shared_cli;
  if (!cli.executable_path) return null;
  const launcher = path.join(cli.package_root, "bin/cli.cjs");
  if (fs.existsSync(launcher)) {
    const script = /\.(cmd|bat)$/i.test(cli.executable_path) ? windowsShimScript(cli.executable_path) : cli.executable_path;
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

function validateInspection(receipt, backend) {
  const inspection = receipt.inspection;
  if (receipt.format_version !== 1 || receipt.status !== "ok" || receipt.backend !== backend || !inspection ||
      !["cli", "server"].includes(receipt.origin) ||
      !["ready", "not_initialized"].includes(inspection.core_status) ||
      inspection.schema_version !== (inspection.core_status === "ready" ? "1.0" : null) ||
      (inspection.core_status === "not_initialized" ? inspection.visible !== null :
        !inspection.visible || !Number.isInteger(inspection.visible.addressable_total) || !Number.isInteger(inspection.visible.effective_total)) ||
      !["ready", "not_initialized", "degraded"].includes(inspection.activity_status) ||
      (inspection.activity_error !== null && typeof inspection.activity_error !== "string") ||
      !Array.isArray(inspection.capabilities) || capabilities.some((name) => !inspection.capabilities.includes(name))) {
    throw new SetupError("backend_incompatible", "Backend inspection does not satisfy backend-setup-v1");
  }
  return inspection;
}

export async function backendStatus(context) {
  const { runtime, report } = context;
  const database = runtime.env.MEMOCAP_DB || path.join(runtime.env.HOME || runtime.env.USERPROFILE, ".memocap/memocap.db");
  const backend = runtime.env.MEMOCAP_ADDR ? "remote" : "local";
  const executable = inspectionExecutable(context);
  const status = { backend, database: backend === "local" ? path.resolve(runtime.cwd, database) : null,
    status: "not_run", core_schema: { expected: "1.0", status: "not_run" }, activity: { status: "not_run" },
    remote_capabilities: { status: "not_run" }, database_preserved: true, executable_path: executable,
    reason: executable ? null : "cli_unavailable_without_cache_warmup" };
  report.backend = status;
  if (!executable) return status;
  try {
    await verifyExecutable(context, executable);
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
  if (execution.code !== 0) throw new SetupError("backend_inspection_failed", "Backend read-only inspection failed", { backend_code: receipt.error?.code || null });
  const inspection = validateInspection(receipt, status.backend);
  const token = runtime.env.MEMOCAP_TOKEN;
  if (token && inspection.activity_error) inspection.activity_error = inspection.activity_error.replaceAll(token, "[redacted]");
  Object.assign(status, { status: "ok", origin: receipt.origin, inspection,
      core_schema: { expected: "1.0", observed: inspection.schema_version, status: inspection.core_status === "ready" ? "compatible" : "not_initialized" },
      memory_status: inspection.core_status, activity: { status: inspection.activity_status, error: inspection.activity_error },
      remote_capabilities: { status: status.backend === "remote" ? "compatible" : "not_applicable", capabilities: inspection.capabilities } });
}

export function backendReadiness(report) {
  const backend = report.backend;
  if (backend.status !== "ok" || report.repair_required || report.update_available) return "incomplete";
  if (backend.activity.status !== "ready") return `activity_${backend.activity.status}`;
  return backend.memory_status === "not_initialized" ? "installation_ready" : "static_ready";
}

export function backendWarnings(report) {
  const backend = report.backend;
  if (backend.activity.status === "degraded") report.warnings.push({ code: "activity_degraded", message: backend.activity.error });
  if (backend.backend === "remote" && backend.activity.status === "not_initialized") report.warnings.push({ code: "server_admin_required", message: "The server administrator must prepare auxiliary storage" });
  if (backend.memory_status === "not_initialized") report.warnings.push({ code: "memory_not_initialized", message: "Installation can be ready; no runtime memory database exists yet" });
}

export async function prepareBackend(context) {
  await backendStatus(context);
  const { report, runtime } = context;
  if (report.backend.status !== "ok") throw new SetupError("backend_unavailable", "Cannot inspect the installed backend");
  if (report.backend.backend !== "local" || report.backend.activity.status !== "not_initialized") return { status: "unchanged" };
  const execution = await runtime.run(report.backend.executable_path, ["activity", "prepare", "--json"], { env: runtime.env, cwd: runtime.cwd });
  context.manifest.backend = { status: "outcome_unknown", operation: "activity_prepare", database: report.backend.database };
  try { await backendStatus(context); }
  catch { throw new SetupError("activity_outcome_unknown", "Auxiliary preparation readback failed; inspect storage before retrying"); }
  if (report.backend.activity.status !== "ready") throw new SetupError(execution.code ? "activity_outcome_unknown" : "activity_readback_failed", "Auxiliary preparation was not verified; inspect storage before retrying");
  context.manifest.backend = { status: "ready", operation: "activity_prepare", database: report.backend.database };
  return { status: "changed", recovered_after_error: execution.code !== 0 };
}
