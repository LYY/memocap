import fs from "node:fs";
import path from "node:path";
import { SetupError } from "./arguments.mjs";
import { atomicWrite, readText } from "./files.mjs";

const isRecord = (record) => record !== null && typeof record === "object" && !Array.isArray(record);

export function manifestLocation(runtime) {
  return path.join(runtime.env.XDG_STATE_HOME || (runtime.platform === "win32" ? runtime.env.LOCALAPPDATA || path.join(runtime.env.USERPROFILE, "AppData/Local") : path.join(runtime.env.HOME, ".local/state")), "memocap/setup.json");
}

export function loadManifest(runtime) {
  const filename = manifestLocation(runtime);
  const text = readText(filename);
  let manifest;
  try { manifest = text === null ? null : JSON.parse(text); }
  catch (error) { throw new SetupError("invalid_json", `Invalid JSON in ${filename}`, error.message); }
  if (text !== null && (!isRecord(manifest) || manifest.format_version !== 2 || !isRecord(manifest.installs) || !Object.values(manifest.installs).every(isRecord))) throw new SetupError("manifest_version", `Unrecognized setup manifest: ${filename}`);
  return { filename, text, manifest: text === null ? { format_version: 2, installs: {} } : manifest };
}

export function lockManifest(context) {
  fs.mkdirSync(path.dirname(context.manifestPath), { recursive: true });
  const filename = `${context.manifestPath}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(filename, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new SetupError("setup_busy", `Another setup owns ${filename}; inspect owner before manual stale-lock removal`); throw error; }
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  return () => { fs.closeSync(descriptor); fs.unlinkSync(filename); };
}

export function saveManifest(context) {
  try {
    const contents = `${JSON.stringify(context.manifest, null, 2)}\n`;
    const saved = atomicWrite(context.manifestPath, contents, context.manifestText);
    context.manifestText = contents;
    if (saved.backup) context.report.backups.push(saved.backup);
  } catch (error) {
    const failure = { code: "manifest_write_failed", message: error.message, details: { path: context.manifestPath, filesystem_code: error.code } };
    context.report.steps.push({ component: "manifest", scope: "current_user", status: "failed", error: failure });
    throw new SetupError(failure.code, failure.message, failure.details);
  }
}

export async function step(context, component, scope, action) {
  const entry = { component, scope: scope?.id || "current_user", status: "not_run" };
  const previousCLI = context.report.shared_cli.version;
  context.report.steps.push(entry);
  try {
    Object.assign(entry, await action());
  } catch (error) {
    entry.status = /outcome_unknown/.test(error.code || "") ? "outcome_unknown" : "failed";
    if (component === "cli" && context.report.shared_cli.version !== previousCLI) entry.mutation_status = "changed";
    entry.error = { code: error.code || "filesystem_error", message: error.message, details: error.details || null };
    if (scope && context.manifest.installs[scope.id]) context.manifest.installs[scope.id].steps[component] = entry;
    saveManifest(context);
    throw error;
  }
  const savedStatus = scope ? context.manifest.installs[scope.id]?.steps[component]?.status : context.manifest.cli && "unchanged";
  if (entry.status === "unchanged" && ["changed", "unchanged"].includes(savedStatus)) return entry;
  if (scope) {
    context.manifest.installs[scope.id] ||= { kind: scope.kind, directory: scope.directory, config: scope.config, version: context.target, steps: {} };
    const record = context.manifest.installs[scope.id];
    if (context.adoptions?.has(scope.id)) record.adoption = context.adoptions.get(scope.id);
    record.steps[component] = entry;
    record.version = context.target;
    record.manager = context.report.shared_cli.manager;
    record.updated_at = new Date().toISOString();
    if (component === "plugin") record.plugin = entry.plugin;
    if (component === "skill" && ["changed", "unchanged"].includes(entry.status)) record.skill = entry;
  }
  if (component === "cli") context.manifest.cli = entry.observed;
  saveManifest(context);
  return entry;
}
