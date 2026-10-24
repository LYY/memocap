import fs from "node:fs";
import path from "node:path";
import { packageName, SetupError } from "./arguments.mjs";
import { readJSON } from "./files.mjs";

export async function pnpmRoot(runtime) {
  const options = { env: runtime.env, cwd: runtime.env.HOME || runtime.env.USERPROFILE };
  const binConfig = await runtime.run("pnpm", ["config", "get", "global-bin-dir"], options);
  if (binConfig.code !== 0) return null;
  const home = runtime.env.HOME || runtime.env.USERPROFILE;
  const base = runtime.env.PNPM_HOME || (runtime.env.XDG_DATA_HOME ? path.join(runtime.env.XDG_DATA_HOME, "pnpm") : runtime.platform === "darwin" ? path.join(home, "Library/pnpm") : runtime.platform === "win32" ? path.join(runtime.env.LOCALAPPDATA || path.join(home, "AppData/Local"), "pnpm") : path.join(home, ".local/share/pnpm"));
  const version = await runtime.run("pnpm", ["--version"], options);
  const bin = binConfig.stdout.trim() === "undefined" ? Number.parseInt(version.stdout, 10) >= 11 ? path.join(base, "bin") : base : binConfig.stdout.trim();
  if (!path.isAbsolute(bin)) throw new SetupError("manager_bin", "pnpm did not identify an absolute global bin directory");
  if (fs.existsSync(bin)) {
    const execution = await runtime.run("pnpm", ["root", "--global"], options);
    if (execution.code !== 0) return null;
    const root = execution.stdout.trim();
    if (!path.isAbsolute(root)) throw new SetupError("manager_root", "pnpm global root must be absolute");
    if (readJSON(path.join(root, packageName, "package.json"))?.name === packageName) return root;
    const inventory = await runtime.run("pnpm", ["list", "--global", "--json"], options);
    if (inventory.code !== 0) return null;
    let groups;
    try { groups = JSON.parse(inventory.stdout); }
    catch { throw new SetupError("manager_inventory", "pnpm list did not return JSON"); }
    if (!Array.isArray(groups)) throw new SetupError("manager_inventory", "pnpm list must return an array");
    const packages = new Map();
    for (const group of groups) {
      const installed = group.dependencies?.[packageName];
      if (!installed) continue;
      if (typeof installed.path !== "string" || !path.isAbsolute(installed.path)) throw new SetupError("manager_inventory", "pnpm package path must be absolute");
      const metadata = readJSON(path.join(installed.path, "package.json"));
      if (metadata?.name !== packageName || metadata.version !== installed.version) throw new SetupError("package_identity", "pnpm inventory and package identity differ");
      packages.set(fs.realpathSync(installed.path), installed.path);
    }
    if (packages.size > 1) throw new SetupError("duplicate_managers", "Multiple pnpm global installations contain memocap", [...packages.values()]);
    const installed = [...packages.values()][0];
    return installed ? path.dirname(path.dirname(installed)) : null;
  }
  const directoryConfig = await runtime.run("pnpm", ["config", "get", "global-dir"], options);
  if (directoryConfig.code !== 0) return null;
  const directory = directoryConfig.stdout.trim() === "undefined" ? path.join(base, "global") : directoryConfig.stdout.trim();
  if (!path.isAbsolute(directory)) throw new SetupError("manager_root", "pnpm global directory must be absolute");
  if (!fs.existsSync(directory)) return null;
  const roots = [directory, path.join(directory, "5")]
    .map((entry) => path.join(entry, "node_modules")).filter((root) => readJSON(path.join(root, packageName, "package.json"))?.name === packageName);
  if (roots.length > 1) throw new SetupError("duplicate_managers", "Multiple pnpm global layouts contain memocap", roots);
  return roots[0] || null;
}
