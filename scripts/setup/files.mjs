import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SetupError } from "./arguments.mjs";

export function readText(filename) {
  try { return fs.readFileSync(filename, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function readJSON(filename) {
  const contents = readText(filename);
  if (contents === null) return null;
  try { return JSON.parse(contents); }
  catch (error) { throw new SetupError("invalid_json", `Invalid JSON in ${filename}`, error.message); }
}

export function digest(contents) {
  return contents === null ? null : createHash("sha256").update(contents).digest("hex");
}

export function atomicWrite(filename, contents, previous) {
  if (readText(filename) !== previous) throw new SetupError("concurrent_change", `File changed while planning: ${filename}`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const suffix = `${Date.now()}-${randomUUID()}`;
  const backup = previous === null ? null : `${filename}.memocap-before-${suffix}`;
  if (backup) fs.writeFileSync(backup, previous, { flag: "wx", mode: 0o600 });
  const temporary = `${filename}.memocap-${suffix}.tmp`;
  try {
    const mode = previous === null ? 0o600 : fs.statSync(filename).mode & 0o777;
    fs.writeFileSync(temporary, contents, { flag: "wx", mode });
    const descriptor = fs.openSync(temporary, "r+");
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    if (readText(filename) !== previous) throw new SetupError("concurrent_change", `File changed before rename: ${filename}`, { backup });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { backup, digest: digest(contents) };
}

export function ancestors(directory) {
  const directories = [];
  for (let current = directory; ; current = path.dirname(current)) {
    directories.push(current);
    if (fs.existsSync(path.join(current, ".git")) || path.dirname(current) === current) return directories;
  }
}

export function skillFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const found = [];
  function walk(current, depth, parents) {
    const real = fs.realpathSync(current);
    if (parents.has(real)) return;
    const lineage = new Set([...parents, real]);
    if (depth > 6) throw new SetupError("discovery_depth", `Skill discovery too deep: ${current}`);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (["node_modules", ".pnpm", ".git", "vendor"].includes(entry.name)) continue;
      const filename = path.join(current, entry.name);
      if (entry.name === "SKILL.md" && entry.isFile()) found.push(filename);
      else if (entry.isDirectory() || (entry.isSymbolicLink() && fs.existsSync(filename) && fs.statSync(filename).isDirectory())) walk(filename, depth + 1, lineage);
    }
  }
  walk(directory, 0, new Set());
  return found;
}
