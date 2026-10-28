import fs from "node:fs";
import { packageName, SetupError } from "./arguments.mjs";
import { inspectConfig, managedConfigText, managedEntry } from "./config.mjs";
import { digest, readText } from "./files.mjs";
import { assertSkillOwnership, discoverSkill, targetPolicy } from "./skills.mjs";

export function inspectOwner(scope, context) {
  const record = context.manifest.installs[scope.id];
  const pending = record?.intent;
  const actual = inspectConfig(scope, null, context.runtime);
  const committed = pending && digest(scope.text) === pending.after_digest;
  const effectiveRecord = committed ? { ...record, plugin: pending.entry ? { entry: pending.entry } : null, skill: pending.skill || record.skill }
    : pending?.operation === "install" ? { ...record, plugin: record.plugin || (pending.previous_entry ? { entry: pending.previous_entry } : null), skill: pending.previous_skill } : record;
  const plugin = inspectConfig(scope, effectiveRecord, context.runtime);
  const skill = discoverSkill(scope, context.runtime, effectiveRecord);
  return { scope, record, effectiveRecord, plugin, skill, committed: Boolean(committed), actual, owner_id: scope.id, owner_reused: false };
}

export function resolveOwners(context, inspections) {
  for (const inspection of inspections) {
    const registrations = inspection.plugin.registrations;
    if (registrations.length !== 1 || registrations[0].config === inspection.scope.config || inspection.record) continue;
    const inherited = registrations[0];
    const match = Object.entries(context.manifest.installs).find(([, record]) => record.config === inherited.config && record.kind === "global");
    if (!match || inspection.scope.kind !== "project") continue;
    const [id, owner] = match;
    const selected = context.scopes.find((scope) => scope.id === id);
    const scope = selected || { ...inspection.scope, kind: owner.kind, id, config: owner.config, text: readText(owner.config) };
    const ownerInspection = inspectOwner(scope, context);
    const exactEntry = JSON.stringify(inherited.entry) === JSON.stringify(owner.plugin?.entry);
    const sameTarget = owner.skill?.version === context.target && owner.skill?.digest === context.bundle.digest;
    if (!exactEntry || owner.skill?.kind !== "managed" || (!sameTarget && !selected && context.options.command !== "uninstall")) continue;
    inspection.owner_id = id;
    inspection.owner_reused = true;
    inspection.owner = ownerInspection;
    inspection.plugin.conflicts = inspection.plugin.conflicts.filter((conflict) => conflict.code !== "plugin_layer_conflict" || conflict.path !== owner.config);
    inspection.plugin.entries = [inherited.entry];
    inspection.skill = discoverSkill(inspection.scope, context.runtime, ownerInspection.effectiveRecord);
  }
}

export function preflightOwner(inspection, context) {
  const { plugin, record, scope } = inspection;
  if (plugin.conflicts.length) {
    const conflict = plugin.conflicts[0];
    throw new SetupError(conflict.code, `Configuration conflict at ${conflict.path}`, plugin.conflicts);
  }
  if (plugin.registrations.length > 1) throw new SetupError("duplicate_plugin", "Plugin arrays append across config layers", plugin.registrations);
  if (inspection.owner_reused) {
    preflightOwner(inspection.owner, context);
    context.activeScope = scope;
    assertSkillOwnership(inspection.skill, inspection.owner.effectiveRecord, context);
    return;
  }
  if (record?.intent && (record.intent.target !== context.target || record.intent.operation !== (context.options.command === "uninstall" ? "uninstall" : "install"))) throw new SetupError("pending_operation", "Resume the persisted operation with the same target first", record.intent.target);
  context.activeScope = scope;
  assertSkillOwnership(inspection.skill, inspection.effectiveRecord, context);
  const existing = plugin.entries[0];
  if (existing && !inspection.effectiveRecord?.plugin) {
    const version = Array.isArray(existing) ? existing[0].slice(`${packageName}@`.length) : existing.slice(`${packageName}@`.length);
    if (!context.report.shared_cli.package_root || version !== context.report.shared_cli.version || (Array.isArray(existing) && existing[1]?.skillDirectory)) throw new SetupError("unowned_plugin", "Cannot prove installed package owns this plugin", { existing });
    inspection.adoption = { version, source: context.report.shared_cli.package_root };
  }
  if (context.options.command !== "uninstall") {
    const selectedDirectory = Array.isArray(existing) ? existing[1]?.skillDirectory : null;
    if (selectedDirectory && inspection.skill.managed && selectedDirectory !== inspection.skill.managed.path) throw new SetupError("plugin_modified", "Plugin selects a different policy directory");
    const destination = targetPolicy(scope, context);
    if (fs.existsSync(destination.path) && destination.path !== inspection.skill.managed?.path) {
      const foreign = discoverSkill(scope, context.runtime, { skill: destination });
      if (foreign.inspectionError || foreign.observed?.digest !== destination.digest) throw new SetupError("policy_collision", "Target payload already differs", destination.path);
    }
    installIntent(inspection, context);
  }
}

export function installIntent(inspection, context) {
  if (inspection.record?.intent) return inspection.record.intent;
  const { scope, plugin, record } = inspection;
  const desired = targetPolicy(scope, context);
  const existingPaths = plugin.config.skills?.paths || [];
  desired.owned_paths = existingPaths.includes(desired.path) ? record?.skill?.owned_paths?.filter((directory) => directory === desired.path) || [] : [desired.path];
  const entry = managedEntry(plugin.entries[0], context.target, desired.path);
  const removePaths = record?.skill?.kind === "managed" ? record.skill.owned_paths : [];
  const after = managedConfigText(scope, entry, removePaths);
  return { operation: "install", target: context.target, entry, previous_entry: plugin.entries[0] || null, skill: desired, remove_paths: removePaths,
    before_digest: digest(scope.text), after_digest: digest(after) };
}
