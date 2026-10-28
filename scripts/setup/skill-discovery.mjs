import fs from "node:fs";
import path from "node:path";
import { SetupError } from "./arguments.mjs";
import { parseConfig } from "./config.mjs";
import { ancestors, readText, skillFiles } from "./files.mjs";

export function resolvedSkillPath(directory, scope) {
  return path.resolve(scope.directory, directory.startsWith("~/") ? path.join(scope.home, directory.slice(2)) : directory);
}

export function discoveryRoots(scope, runtime) {
  const roots = [];
  const enabled = (flag) => flag === "true" || flag === "1";
  if (!enabled(runtime.env.OPENCODE_DISABLE_EXTERNAL_SKILLS)) for (const directory of new Set([scope.home, ...ancestors(scope.directory)])) {
    roots.push({ path: path.join(directory, ".agents/skills"), kind: "external" });
    if (!enabled(runtime.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)) roots.push({ path: path.join(directory, ".claude/skills"), kind: "external" });
  }
  for (const directory of scope.config_directories) for (const name of ["skills", "skill"]) roots.push({ path: path.join(directory, name), kind: "native" });
  for (const filename of new Set([...scope.layers, scope.config])) {
    if (!fs.existsSync(filename)) continue;
    for (const [index, directory] of (parseConfig(filename).skills?.paths || []).entries()) roots.push({ path: resolvedSkillPath(directory, scope), kind: "explicit", config: filename, index, declared_path: directory });
  }
  return roots;
}

function agentReferences(scope, runtime) {
  const references = [];
  const bases = new Set([scope.home, scope.directory, runtime.env.XDG_CONFIG_HOME || path.join(scope.home, ".config")]);
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const directory = path.join(base, entry.name, "skills/memocap");
      let stat;
      try { stat = fs.lstatSync(directory); } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) continue; throw error; }
      const exists = fs.existsSync(directory);
      const real = exists ? fs.realpathSync(directory) : null;
      references.push({ discovery_path: directory, path: real, broken: !exists, link_target: stat.isSymbolicLink() ? path.resolve(path.dirname(directory), fs.readlinkSync(directory)) : null });
    }
  }
  return references;
}

function declaredName(filename) {
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readText(filename) || "")?.[1];
  if (!frontmatter) return null;
  const names = [...frontmatter.matchAll(/^(?:name|"name"|'name')[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/gm)];
  const failure = () => new SetupError("uninspected_skill_source", `Cannot prove local skill name: ${filename}`);
  if (!names.length) {
    if (/^(?:[ \t]*[{[]|<<[ \t]*:|[ \t]+name[ \t]*:|"[^"\n]*\\)/m.test(frontmatter)) throw failure();
    return null;
  }
  const scalar = names[0][1]?.trim();
  if (names.length !== 1 || !scalar || "!&*[]{}|>".includes(scalar[0])) throw failure();
  if (scalar.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")[ \t]*(?:#.*)?$/.exec(scalar);
    if (!quoted) throw failure();
    try { return JSON.parse(quoted[1]); }
    catch (error) { if (error instanceof SyntaxError) throw failure(); throw error; }
  }
  if (scalar.startsWith("'")) {
    const quoted = /^('(?:[^']|'')*')[ \t]*(?:#.*)?$/.exec(scalar);
    if (!quoted) throw failure();
    return quoted[1].slice(1, -1).replaceAll("''", "'");
  }
  return scalar.split(/[ \t]+#/)[0].trim();
}

export function inventorySkills(scope, runtime) {
  const roots = discoveryRoots(scope, runtime);
  const found = new Map();
  for (const root of roots) for (const filename of skillFiles(root.path)) {
    if (declaredName(filename) !== "memocap") continue;
    const discoveryPath = path.dirname(filename);
    const key = path.resolve(discoveryPath);
    const registration = { ...root };
    if (found.has(key)) found.get(key).registrations.push(registration);
    else found.set(key, { path: fs.realpathSync(discoveryPath), discovery_path: discoveryPath, registrations: [registration] });
  }
  return { roots, discovered: [...found.values()], references: agentReferences(scope, runtime), uninspected_projects: "other_and_future_cwd_not_inspected" };
}
