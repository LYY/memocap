import fs from "node:fs";
import path from "node:path";
import { packageName, SetupError } from "./arguments.mjs";
import { prepareBackups } from "./backups.mjs";
import { prepareBackend } from "./backend.mjs";
import { inspectConfig, isMemocap, parseConfig, pluginSource, removePlugin, writePlugin } from "./config.mjs";
import { installCLI, removeCLI } from "./packages.mjs";
import { assertSkillOwnership, discoverSkill, installSkill, listSkills, removeSkill } from "./skills.mjs";
import { lockManifest, saveManifest, step } from "./manifest.mjs";

export function inspectScopes(context) {
  const selectedConfigs = new Set(context.scopes.map((scope) => scope.config));
  return context.scopes.map((scope) => {
    const record = context.manifest.installs[scope.id];
    const plugin = inspectConfig(scope, record, context.runtime);
    plugin.conflicts = plugin.conflicts.filter((conflict) => conflict.code !== "plugin_layer_conflict" || (conflict.source !== `${packageName}@${context.target}` && !selectedConfigs.has(conflict.path)));
    const skill = discoverSkill(scope, context.runtime, record);
    return { scope, record, plugin, skill };
  });
}

export function scopeReports(inspections, target) {
  return inspections.map(({ scope, plugin, skill, record }) => ({ id: scope.id, kind: scope.kind, directory: scope.directory, config: scope.config,
    higher_precedence: scope.higher_precedence, effective_layers: scope.layers.filter((filename) => fs.existsSync(filename)),
    plugin: { status: plugin.conflicts.length ? "conflict" : plugin.entries.length ? "configured" : "missing", entries: plugin.entries, conflicts: plugin.conflicts,
      target_pin: `${packageName}@${target}` },
    skill: { status: skill.selected?.discovery_path ? "discovered" : "missing", installed: skill.selected, source: skill.lock.entry, other_discovery: skill.discovered },
    manifest_owned: Boolean(record), adoption: record?.adoption || null }));
}

export function preflight(context, inspections) {
  context.adoptions = new Map();
  for (const inspection of inspections) {
    if (inspection.plugin.conflicts.length) {
      const conflict = inspection.plugin.conflicts[0];
      throw new SetupError(conflict.code, `Configuration conflict at ${conflict.path}`, inspection.plugin.conflicts);
    }
    assertSkillOwnership(inspection.skill, inspection.record, context);
    const existing = inspection.plugin.entries[0];
    if (existing && !inspection.record?.plugin) {
      const version = pluginSource(existing).slice(`${packageName}@`.length);
      if (version !== context.report.shared_cli.version || !context.report.shared_cli.package_root) throw new SetupError("unowned_plugin", "Cannot prove installed package owns existing plugin pin", { existing });
      if (!["0.0.10", "0.1.0", context.target].includes(version)) throw new SetupError("unowned_plugin", "Legacy adoption supports only proven 0.0.10, 0.1.0 or exact target installations");
      inspection.adoption = { version, source: context.report.shared_cli.package_root };
    }
    if (inspection.adoption || inspection.skill.adoption) context.adoptions.set(inspection.scope.id, { plugin: inspection.adoption || null, skill: inspection.skill.adoption || null });
  }
}

async function verifySharedSkills(context, inspections) {
  for (const { scope, skill } of inspections) {
    const inventory = await listSkills(scope, context.runtime);
    const others = inventory.flatMap((entry) => entry.agents).filter((agent) => agent !== "OpenCode");
    const currentVersion = skill.lock.entry?.ref?.replace(/^v/, "");
    if (others.length && currentVersion !== context.target) throw new SetupError("shared_skill_conflict", "Preserving a skill shared with other agents", { inventory });
  }
}

export async function mutateInstall(context, inspections) {
  context.skillSnapshots = new Map(inspections.map(({ scope, skill }) => [scope.id, skill.selected?.fingerprint || null]));
  await verifySharedSkills(context, inspections);
  const unlock = lockManifest(context);
  try {
    prepareBackups(context, inspections);
    await step(context, "cli", null, () => installCLI(context));
    for (const { scope, plugin } of inspections) {
      await step(context, "plugin", scope, async () => {
        const source = `${packageName}@${context.target}`;
        const previousEntry = plugin.entries[0];
        const entry = Array.isArray(previousEntry) ? [source, ...previousEntry.slice(1)] : source;
        const unchanged = JSON.stringify(previousEntry) === JSON.stringify(entry);
        const saved = unchanged ? { backup: null } : writePlugin(scope, entry);
        const observed = (parseConfig(scope.config).plugin || []).filter(isMemocap);
        if (observed.length !== 1 || JSON.stringify(observed[0]) !== JSON.stringify(entry)) throw new SetupError("plugin_readback", scope.config);
        if (saved.backup) context.report.backups.push(saved.backup);
        return { status: unchanged ? "unchanged" : "changed", plugin: { entry, config_digest: saved.digest || plugin.digest, backup: saved.backup } };
      });
      await step(context, "skill", scope, () => installSkill(scope, context));
    }
    await step(context, "backend", null, () => prepareBackend(context));
  } finally { unlock(); }
}

export async function mutateUninstall(context, inspections) {
  const unlock = lockManifest(context);
  try {
    for (const { scope, record } of inspections) {
      if (!record) throw new SetupError("unowned_installation", `No setup ownership manifest for ${scope.id}; preserving installation`);
      await step(context, "plugin", scope, async () => {
        const saved = removePlugin(scope, record);
        if (saved.backup) context.report.backups.push(saved.backup);
        return { status: saved.backup ? "changed" : "unchanged", plugin: record.plugin };
      });
      const skill = await step(context, "skill", scope, () => removeSkill(scope, context, record));
      if (skill.status === "retained_shared") {
        record.retained_shared_skill = skill;
        delete record.plugin;
      } else delete context.manifest.installs[scope.id];
      saveManifest(context);
    }
    if (context.options.removeCLI) {
      if (context.scopes.some((scope) => hasExternalReferences(scope))) throw new SetupError("cli_references_remain", "Unowned memocap plugin/skill references remain; CLI preserved");
      await step(context, "cli", null, () => removeCLI(context));
    }
  } finally { unlock(); }
}

function hasExternalReferences(scope) {
  for (const filename of scope.layers) if (fs.existsSync(filename) && (parseConfig(filename).plugin || []).some(isMemocap)) return true;
  const roots = [path.join(scope.home, ".agents/skills/memocap"), ...scope.config_directories.map((directory) => path.join(directory, "skills/memocap"))];
  return roots.some((directory) => fs.existsSync(directory));
}

export function appendPendingSteps(context) {
  const existing = new Set(context.report.steps.map((entry) => `${entry.scope}:${entry.component}`));
  for (const scope of context.scopes || []) for (const component of ["plugin", "skill"]) {
    const key = `${scope.id}:${component}`;
    if (!existing.has(key)) context.report.steps.push({ component, scope: scope.id, status: "not_run" });
  }
}
