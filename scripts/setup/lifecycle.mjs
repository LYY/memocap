import fs from "node:fs";
import path from "node:path";
import { packageName, SetupError } from "./arguments.mjs";
import { prepareBackend } from "./backend.mjs";
import { prepareBackups } from "./backups.mjs";
import { isMemocap, managedConfigText, parseConfig, writeManagedConfig } from "./config.mjs";
import { digest, readText } from "./files.mjs";
import { lockManifest, saveManifest, step } from "./manifest.mjs";
import { installCLI, removeCLI } from "./packages.mjs";
import { inspectOwner, installIntent, preflightOwner, resolveOwners } from "./skill-owner.mjs";
import { installSkill, removeSkill } from "./skills.mjs";

export function inspectScopes(context) {
  const inspections = context.scopes.map((scope) => inspectOwner(scope, context));
  resolveOwners(context, inspections);
  return inspections;
}

export function scopeReports(inspections, target) {
  return inspections.map(({ scope, plugin, skill, record, owner_id, owner_reused }) => ({ id: scope.id, kind: scope.kind, directory: scope.directory, config: scope.config,
    owner_id, owner_reused, higher_precedence: scope.higher_precedence, effective_layers: scope.layers.filter((filename) => fs.existsSync(filename)),
    plugin: { status: plugin.conflicts.length ? "conflict" : plugin.entries.length ? "configured" : "missing", entries: plugin.entries, conflicts: plugin.conflicts, registrations: plugin.registrations, target_pin: `${packageName}@${target}` },
    skill: { status: skill.selected?.discovery_path ? "discovered" : "missing", kind: skill.managed ? "managed" : "unmanaged", installed: skill.selected,
      source: skill.managed ? { kind: "bundle", version: skill.managed.source_version, digest: skill.managed.digest } : null,
      plugin_expected_path: Array.isArray(plugin.entries[0]) ? plugin.entries[0][1]?.skillDirectory || null : null,
      host_expected_path: skill.selected?.path || null, digest: skill.observed?.digest || null, other_discovery: skill.discovered, checked_roots: skill.roots,
      agent_references: skill.references, uninspected_projects: skill.uninspected_projects, drift: skill.inspectionError || (skill.observed && skill.observed.digest !== skill.managed?.digest ? "digest_mismatch" : null) },
    manifest_owned: Boolean(record), adoption: record?.adoption?.plugin ? { plugin: record.adoption.plugin } : null }));
}

export function preflight(context, inspections) {
  context.adoptions = new Map();
  for (const inspection of inspections) {
    preflightOwner(inspection, context);
    if (inspection.adoption) context.adoptions.set(inspection.scope.id, { plugin: inspection.adoption });
    if (context.options.command === "uninstall" && !inspection.owner_reused && !inspection.record) throw new SetupError("unowned_installation", `No setup ownership for ${inspection.scope.id}`);
  }
  context.report.scopes = scopeReports(inspections, context.target);
}

function lockedReadback(context) {
  if (readText(context.manifestPath) !== context.manifestText) throw new SetupError("concurrent_change", "Manifest changed since preflight");
  for (const scope of context.scopes) if (readText(scope.config) !== scope.text) throw new SetupError("concurrent_change", `Config changed since preflight: ${scope.config}`);
  const inspections = inspectScopes(context);
  preflight(context, inspections);
  return inspections;
}

function persistIntent(context, inspection) {
  const { scope } = inspection;
  const intent = installIntent(inspection, context);
  if (inspection.record?.intent) {
    if (inspection.committed && inspection.skill.observed?.digest === intent.skill.digest && JSON.stringify(inspection.record.plugin?.entry) !== JSON.stringify(intent.entry)) {
      inspection.record.plugin = { entry: intent.entry, config: scope.config, config_digest: digest(scope.text), backup: null };
      inspection.record.skill = { ...intent.skill, status: "unchanged" };
      saveManifest(context);
      context.report.steps.push({ component: "intent", scope: scope.id, status: "changed", recovered_after_error: true });
    }
    return intent;
  }
  if (intent.after_digest === intent.before_digest && inspection.skill.observed?.digest === intent.skill.digest && inspection.record?.skill?.version === context.target) return null;
  context.manifest.installs[scope.id] ||= { kind: scope.kind, directory: scope.directory, config: scope.config, version: context.target, steps: {} };
  const record = context.manifest.installs[scope.id];
  record.steps ||= {};
  if (context.adoptions.has(scope.id)) record.adoption = context.adoptions.get(scope.id);
  record.intent = { ...intent, previous_skill: record.skill || null };
  saveManifest(context);
  context.report.steps.push({ component: "intent", scope: scope.id, status: "changed" });
  return record.intent;
}

async function switchConfig(context, scope) {
  const record = context.manifest.installs[scope.id];
  const intent = record.intent;
  if (!intent) return { status: "unchanged", plugin: record.plugin };
  const saved = writeManagedConfig(scope, intent);
  const observed = parseConfig(scope.config);
  const entries = (observed.plugin || []).filter(isMemocap);
  if (JSON.stringify(entries) !== JSON.stringify(intent.entry ? [intent.entry] : []) || (intent.entry && !(observed.skills?.paths || []).includes(intent.skill.path))) throw new SetupError("plugin_readback", scope.config);
  if (saved.backup) context.report.backups.push(saved.backup);
  scope.text = readText(scope.config);
  return { status: saved.status, plugin: intent.entry ? { entry: intent.entry, config: scope.config, config_digest: saved.digest, backup: saved.backup } : record.plugin };
}

export async function mutateInstall(context) {
  const unlock = lockManifest(context);
  try {
    const inspections = lockedReadback(context).filter((inspection) => !inspection.owner_reused);
    prepareBackups(context, inspections);
    for (const inspection of inspections) persistIntent(context, inspection);
    await step(context, "cli", null, () => installCLI(context));
    for (const inspection of inspections) {
      const { scope } = inspection;
      preflight(context, inspectScopes(context));
      await step(context, "skill", scope, () => installSkill(scope, context));
      const record = context.manifest.installs[scope.id];
      await step(context, "plugin", scope, () => switchConfig(context, scope));
      const previous = record.intent?.previous_skill;
      if (previous?.kind === "managed" && previous.path !== record.skill.path) await step(context, "retired_policy", scope, () => removeSkill(scope, context, { skill: previous }));
    }
    await step(context, "backend", null, () => prepareBackend(context));
    let completed = false;
    for (const inspection of inspections) {
      const record = context.manifest.installs[inspection.scope.id];
      if (record.intent) { delete record.intent; completed = true; }
    }
    if (completed) saveManifest(context);
  } finally { unlock(); }
}

export async function mutateUninstall(context, original) {
  if (original.every((inspection) => inspection.owner_reused)) {
    if (context.options.removeCLI) throw new SetupError("cli_references_remain", "The inherited global owner still requires the CLI");
    return;
  }
  const unlock = lockManifest(context);
  try {
    const inspections = lockedReadback(context).filter((inspection) => !inspection.owner_reused);
    for (const { scope } of inspections) {
      const record = context.manifest.installs[scope.id];
      record.steps ||= {};
      if (!record.intent) {
        const removePaths = record.skill?.kind === "managed" ? record.skill.owned_paths : [];
        record.intent = { operation: "uninstall", target: context.target, entry: null, previous_entry: record.plugin?.entry || null, remove_paths: removePaths,
          before_digest: digest(scope.text), after_digest: digest(managedConfigText(scope, null, removePaths)) };
        saveManifest(context);
      }
      await step(context, "plugin", scope, () => switchConfig(context, scope));
      const removed = await step(context, "skill_removal", scope, () => removeSkill(scope, context, record));
      if (removed.status === "retained_shared" && !removed.known_owners.length) { record.state = "retained_shared"; delete record.intent; }
      else delete context.manifest.installs[scope.id];
      saveManifest(context);
    }
    if (context.options.removeCLI) {
      if (context.scopes.some((scope) => hasExternalReferences(scope))) throw new SetupError("cli_references_remain", "Unowned references remain; CLI preserved");
      await step(context, "cli", null, () => removeCLI(context));
    }
  } finally { unlock(); }
}

function hasExternalReferences(scope) {
  for (const filename of scope.layers) if (fs.existsSync(filename) && (parseConfig(filename).plugin || []).some(isMemocap)) return true;
  return [path.join(scope.home, ".agents/skills/memocap"), ...scope.config_directories.map((directory) => path.join(directory, "skills/memocap"))].some((directory) => fs.existsSync(directory));
}

export function appendPendingSteps(context) {
  const existing = new Set(context.report.steps.map((entry) => `${entry.scope}:${entry.component}`));
  for (const scope of context.scopes || []) for (const component of ["plugin", "skill"]) if (!existing.has(`${scope.id}:${component}`)) context.report.steps.push({ component, scope: scope.id, status: "not_run" });
}
