import fs from "node:fs";
import path from "node:path";
import { inspectPolicy } from "../../lib/policy.mjs";
import { SetupError } from "./arguments.mjs";
import { isMemocap, parseConfig } from "./config.mjs";
import { fingerprint } from "./files.mjs";
import { copyPolicy, policyDirectory } from "./policy.mjs";
import { inventorySkills, resolvedSkillPath } from "./skill-discovery.mjs";
import { legacyPlan, skillLock } from "./skill-legacy.mjs";

export { skillLock } from "./skill-legacy.mjs";

function physicalPath(directory) {
  if (fs.existsSync(directory)) return fs.realpathSync(directory);
  return path.join(physicalPath(path.dirname(directory)), path.basename(directory));
}

export function targetPolicy(scope, context) {
  const bundle = context.bundle || inspectPolicy(path.join(context.runtime.packageRoot, "skills/memocap"), context.runtime.policyMetadata);
  const directory = physicalPath(policyDirectory(scope, context.runtime, context.target, bundle.digest));
  return { kind: "managed", path: directory, mainPath: path.join(directory, "SKILL.md"), version: context.target, source_version: context.report.runner_version,
    digest: bundle.digest, payload_root: path.resolve(directory, "../../../.."), owned_paths: [] };
}

export function discoverSkill(scope, runtime, record) {
  const inventory = inventorySkills(scope, runtime);
  const canonical = path.join(scope.kind === "global" ? scope.home : scope.directory, ".agents/skills/memocap");
  const managed = record?.skill?.kind === "managed" ? record.skill : null;
  const candidates = [...inventory.discovered];
  if (!managed && fs.existsSync(canonical) && !candidates.some((candidate) => candidate.path === fs.realpathSync(canonical))) candidates.push({ path: fs.realpathSync(canonical), discovery_path: null, registrations: [] });
  if (!managed) for (const candidate of candidates) candidate.fingerprint = fingerprint(candidate.path);
  const selected = managed ? candidates.find((candidate) => physicalPath(candidate.path) === physicalPath(managed.path)) || null : candidates[0] || null;
  let observed = null;
  let inspectionError = null;
  if (managed && fs.existsSync(managed.path)) {
    try { observed = inspectPolicy(managed.path, runtime.policyMetadata); }
    catch (error) { inspectionError = { code: error.code || "policy_invalid", message: error.message }; }
  }
  if (selected && managed) Object.assign(selected, { kind: "managed", digest: observed?.digest || null, mainPath: observed?.mainPath || managed.mainPath, version: managed.version });
  return { ...inventory, canonical, candidates, selected, observed, inspectionError, managed, lock: skillLock(scope, runtime) };
}

export function assertSkillOwnership(inspection, record, context) {
  if (!inspection.managed) {
    inspection.migration = legacyPlan(inspection, record, context);
    return;
  }
  const managed = inspection.managed;
  if (context.options?.command !== "uninstall" && (inspection.inspectionError || (inspection.observed && inspection.observed.digest !== managed.digest))) throw new SetupError("skill_modified", `Preserving changed managed payload: ${managed.path}`, inspection.inspectionError);
  const extra = inspection.discovered.filter((candidate) => candidate.path !== physicalPath(managed.path) || path.resolve(candidate.discovery_path) !== path.resolve(managed.path));
  const registrations = inspection.roots.filter((root) => root.kind === "explicit" && resolvedSkillPath(root.declared_path, context.activeScope || { directory: "/", home: "/" }) === managed.path);
  if (extra.length || inspection.discovered.length > 1 || registrations.length > 1) throw new SetupError("duplicate_skill", "Multiple memocap discovery entries are visible", inspection.discovered);
}

export function installSkill(scope, context) {
  const record = context.manifest.installs[scope.id];
  if (!record.intent) return { ...record.skill, status: "unchanged" };
  const desired = record.intent.skill;
  const policy = copyPolicy(path.join(context.runtime.packageRoot, "skills/memocap"), desired.path, desired.digest, context.runtime.policyMetadata);
  return { ...desired, path: policy.directory, mainPath: policy.mainPath, status: policy.status };
}

function remainingReferences(scope, context, skill) {
  const configs = new Set([...scope.layers, ...Object.values(context.manifest.installs).map((record) => record.config)].filter(Boolean));
  const references = [];
  for (const filename of configs) {
    if (!fs.existsSync(filename)) continue;
    const config = parseConfig(filename);
    if ((config.plugin || []).some((entry) => isMemocap(entry) && Array.isArray(entry) && entry[1]?.skillDirectory && physicalPath(entry[1].skillDirectory) === skill.path) || (config.skills?.paths || []).some((directory) => physicalPath(resolvedSkillPath(directory, scope)) === skill.path)) references.push(filename);
  }
  for (const [id, record] of Object.entries(context.manifest.installs)) if (id !== scope.id && record.skill?.path === skill.path) references.push(id);
  for (const reference of inventorySkills(scope, context.runtime).references) if (reference.path === skill.path) references.push(reference.discovery_path);
  return references;
}

export function removeSkill(scope, context, record) {
  const skill = record.skill;
  if (skill?.kind !== "managed") return { status: "retained_legacy", path: skill?.path || null };
  const references = remainingReferences(scope, context, skill);
  if (references.length) return { status: "retained_shared", path: skill.path, references,
    known_owners: Object.entries(context.manifest.installs).filter(([id, record]) => id !== scope.id && record.skill?.path === skill.path).map(([id]) => id) };
  if (!fs.existsSync(skill.path)) return { status: "unchanged" };
  let policy;
  try { policy = inspectPolicy(skill.path, context.runtime.policyMetadata); }
  catch (error) {
    if (!error.code?.startsWith("policy_") && !["ENOENT", "ERR_ENCODING_INVALID_ENCODED_DATA"].includes(error.code)) throw error;
    context.report.warnings.push({ code: "skill_modified", path: skill.path });
    return { status: "retained_modified", path: skill.path };
  }
  if (policy.digest !== skill.digest) {
    context.report.warnings.push({ code: "skill_modified", path: skill.path });
    return { status: "retained_modified", path: skill.path };
  }
  fs.rmSync(skill.path, { recursive: true });
  return { status: "changed", path: skill.path };
}
