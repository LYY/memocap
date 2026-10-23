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
    return execution.code === 0 ? execution.stdout.trim() : null;
  }
  const directoryConfig = await runtime.run("pnpm", ["config", "get", "global-dir"], options);
  if (directoryConfig.code !== 0) return null;
  const directory = directoryConfig.stdout.trim() === "undefined" ? path.join(base, "global") : directoryConfig.stdout.trim();
  if (!path.isAbsolute(directory)) throw new SetupError("manager_root", "pnpm global directory must be absolute");
  if (!fs.existsSync(directory)) return null;
  const roots = [directory, ...fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name))]
    .map((entry) => path.join(entry, "node_modules")).filter((root) => readJSON(path.join(root, packageName, "package.json"))?.name === packageName);
  if (roots.length > 1) throw new SetupError("duplicate_managers", "Multiple pnpm global layouts contain memocap", roots);
  return roots[0] || null;
}
