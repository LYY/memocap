import fs from "node:fs";
import path from "node:path";
import { SetupError } from "./arguments.mjs";
import { parseConfig } from "./config.mjs";
import { ancestors, fingerprint, readJSON, readText, skillFiles } from "./files.mjs";

export function skillLock(scope, runtime) {
  const filename = scope.kind === "project" ? path.join(scope.directory, "skills-lock.json")
    : runtime.env.XDG_STATE_HOME ? path.join(runtime.env.XDG_STATE_HOME, "skills/.skill-lock.json") : path.join(scope.home, ".agents/.skill-lock.json");
  const lock = readJSON(filename);
  if (lock && (lock.version !== (scope.kind === "project" ? 1 : 3) || !lock.skills)) throw new SetupError("unsupported_skill_lock", `Refusing to rewrite unknown or old skills lock: ${filename}`);
  return { filename, entry: lock?.skills.memocap || null };
}

function discoveryRoots(scope, runtime) {
  const roots = [];
  const enabled = (flag) => flag === "true" || flag === "1";
  if (!enabled(runtime.env.OPENCODE_DISABLE_EXTERNAL_SKILLS)) {
    for (const directory of [scope.home, ...ancestors(scope.directory)]) {
      roots.push(path.join(directory, ".agents/skills"));
      if (!enabled(runtime.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)) roots.push(path.join(directory, ".claude/skills"));
    }
  }
  for (const directory of scope.config_directories) roots.push(path.join(directory, "skills"), path.join(directory, "skill"));
  for (const filename of [...scope.layers, scope.config]) {
    if (!fs.existsSync(filename)) continue;
    const configured = parseConfig(filename).skills?.paths || [];
    for (const directory of configured) roots.push(path.resolve(scope.directory, directory.startsWith("~/") ? path.join(scope.home, directory.slice(2)) : directory));
  }
  return [...new Set(roots)];
}

export function discoverSkill(scope, runtime, record) {
  const lock = skillLock(scope, runtime);
  const found = new Map();
  for (const root of discoveryRoots(scope, runtime)) {
    for (const filename of skillFiles(root)) {
      const contents = readText(filename);
      if (!/^name:\s*["']?memocap["']?\s*$/m.test(contents)) continue;
      const directory = fs.realpathSync(path.dirname(filename));
      found.set(directory, { path: directory, discovery_path: path.dirname(filename), fingerprint: fingerprint(directory) });
    }
  }
  const base = scope.kind === "global" ? scope.home : scope.directory;
  const canonical = path.join(base, ".agents/skills/memocap");
  if (fs.existsSync(canonical)) {
    const real = fs.realpathSync(canonical);
    if (!found.has(real)) found.set(real, { path: real, discovery_path: null, fingerprint: fingerprint(real) });
  }
  const canonicalPath = fs.existsSync(canonical) ? fs.realpathSync(canonical) : null;
  const local = [...found.values()].filter((skill) => skill.path === canonicalPath || (scope.kind === "global" ? !(skill.discovery_path || skill.path).startsWith(`${scope.directory}${path.sep}.agents${path.sep}`) : (skill.discovery_path || skill.path).startsWith(`${scope.directory}${path.sep}`)));
  const candidates = local;
  if (record?.skill?.path) candidates.sort((left, right) => Number(right.path === record.skill.path) - Number(left.path === record.skill.path));
  return { candidates, discovered: [...found.values()], lock, selected: candidates[0] || null, list: null };
}

export async function listSkills(scope, runtime) {
  const args = ["--yes", "skills@1.7.4", "list", ...(scope.kind === "global" ? ["--global"] : []), "--json"];
  const execution = await runtime.run("npx", args, { cwd: scope.directory, env: { ...runtime.env, DISABLE_TELEMETRY: "1" }, stdoutFile: true });
  if (execution.code !== 0) throw new SetupError("process_failed", `npx exited ${execution.code}`, { command: "npx", args, stderr: execution.stderr, stdout: execution.stdout });
  let inventory;
  try { inventory = JSON.parse(execution.stdout); } catch { throw new SetupError("skills_response", "skills list did not return JSON"); }
  if (!Array.isArray(inventory) || inventory.some((entry) => !entry || typeof entry.name !== "string" || typeof entry.path !== "string" || !Array.isArray(entry.agents) || entry.agents.some((agent) => typeof agent !== "string"))) throw new SetupError("skills_response", "Invalid skills list inventory");
  return inventory.filter((entry) => entry.name === "memocap");
}

export function skillInstallArguments(scope, target) {
  return ["--yes", "skills@1.7.4", "add", `https://github.com/LYY/memocap/tree/v${target}`, "--skill", "memocap", "--agent", "opencode", ...(scope.kind === "global" ? ["--global"] : []), "--yes"];
}

export function assertSkillOwnership(inspection, record, context) {
  const selected = inspection.selected;
  if (inspection.candidates.length > 1) throw new SetupError("duplicate_skill", "Multiple distinct memocap skill contents are discoverable", inspection.candidates);
  if (!selected) return;
  if (record?.skill) {
    if (selected.fingerprint !== record.skill.fingerprint) throw new SetupError("skill_modified", `Preserving changed skill: ${selected.path}`);
    return;
  }
  const entry = inspection.lock.entry;
  const sourceVersion = entry?.ref?.replace(/^v/, "");
  const installed = context.report.shared_cli;
  const expected = sourceVersion === installed.version && installed.package_root ? fingerprint(path.join(installed.package_root, "skills/memocap")) : null;
  if (entry?.source !== "LYY/memocap" || entry.sourceType !== "github" || !["0.0.10", "0.1.0", context.target].includes(sourceVersion) ||
      entry.ref !== `v${sourceVersion}` || (entry.skillPath !== undefined && entry.skillPath !== "skills/memocap/SKILL.md") ||
      (entry.sourceUrl && !["https://github.com/LYY/memocap.git", `https://github.com/LYY/memocap/tree/v${sourceVersion}`].includes(entry.sourceUrl)) || !expected || selected.fingerprint !== expected || !selected.discovery_path) {
    throw new SetupError("unowned_skill", `Cannot prove original release contents of ${selected.path}`, { lock: entry });
  }
  inspection.adoption = { source: entry.source, ref: entry.ref, fingerprint: expected };
}

export async function installSkill(scope, context) {
  const expected = fingerprint(path.join(context.runtime.packageRoot, "skills/memocap"));
  if (!expected) throw new SetupError("missing_skill_payload", "Target package has no skill payload");
  let inspection = discoverSkill(scope, context.runtime, context.manifest.installs[scope.id]);
  if ((inspection.selected?.fingerprint || null) !== context.skillSnapshots.get(scope.id)) throw new SetupError("skill_modified", "Skill changed since preflight; preserving it");
  const source = `https://github.com/LYY/memocap/tree/v${context.target}`;
  const list = await listSkills(scope, context.runtime);
  const shared = list.flatMap((entry) => entry.agents).filter((agent) => agent !== "OpenCode");
  const needed = inspection.selected?.fingerprint !== expected || (inspection.lock.entry?.ref !== `v${context.target}` && inspection.lock.entry?.sourceUrl !== source) || !inspection.selected?.discovery_path;
  if (needed && shared.length) throw new SetupError("shared_skill_conflict", "Updating this canonical skill would change other agents", { agents: [...new Set(shared)], list });
  let execution = null;
  if (needed) {
    const beforeWrite = discoverSkill(scope, context.runtime, context.manifest.installs[scope.id]);
    if (beforeWrite.selected?.fingerprint !== inspection.selected?.fingerprint) throw new SetupError("skill_modified", "Skill changed during dependency discovery; preserving it");
    execution = await context.runtime.run("npx", skillInstallArguments(scope, context.target), { cwd: scope.directory, env: { ...context.runtime.env, DISABLE_TELEMETRY: "1" } });
  }
  inspection = discoverSkill(scope, context.runtime, context.manifest.installs[scope.id]);
  const after = await listSkills(scope, context.runtime);
  if (inspection.selected?.fingerprint !== expected || !inspection.selected.discovery_path || !after.some((entry) => fs.realpathSync(entry.path) === inspection.selected.path)) {
    throw new SetupError(execution?.code ? "skill_outcome_unknown" : "skill_readback", "Skill source/content/discovery did not match target", { execution, inspection, inventory: after });
  }
  const metadata = inspection.lock.entry;
  if (metadata?.source !== "LYY/memocap" || metadata.sourceType !== "github" || (metadata.ref !== `v${context.target}` && metadata.sourceUrl !== source)) throw new SetupError("skill_source_readback", "Skill lock does not identify the target release", metadata);
  return { status: needed ? "changed" : "unchanged", path: inspection.selected.path, discovery_path: inspection.selected.discovery_path, fingerprint: expected, source, version: context.target, agents: after.flatMap((entry) => entry.agents), recovered_after_error: Boolean(execution?.code) };
}

export async function removeSkill(scope, context, record) {
  const inspection = discoverSkill(scope, context.runtime, record);
  if (!inspection.selected) return { status: "unchanged" };
  if (!record?.skill || inspection.selected.fingerprint !== record.skill.fingerprint) throw new SetupError("skill_modified", "Preserving unowned or modified skill", inspection.selected);
  const inventory = await listSkills(scope, context.runtime);
  const otherAgents = inventory.flatMap((entry) => entry.agents).filter((agent) => agent !== "OpenCode");
  if (otherAgents.length) return { status: "retained_shared", agents: otherAgents, path: inspection.selected.path };
  if (discoverSkill(scope, context.runtime, record).selected?.fingerprint !== inspection.selected.fingerprint) throw new SetupError("skill_modified", "Skill changed during uninstall inventory; preserving it");
  const execution = await context.runtime.run("npx", ["--yes", "skills@1.7.4", "remove", "memocap", "--agent", "opencode", ...(scope.kind === "global" ? ["--global"] : []), "--yes"], { cwd: scope.directory, env: { ...context.runtime.env, DISABLE_TELEMETRY: "1" } });
  const after = await listSkills(scope, context.runtime);
  const remaining = discoverSkill(scope, context.runtime, record);
  if (remaining.selected?.discovery_path || after.some((entry) => entry.agents.includes("OpenCode"))) throw new SetupError("skill_remove_failed", "OpenCode skill reference remains", { execution, inventory: after, remaining });
  return { status: "changed", preserved_other_agents: true };
}
