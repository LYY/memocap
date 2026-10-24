import fs from "node:fs";
import path from "node:path";
import { compareVersions, exactVersion, packageName, SetupError } from "./arguments.mjs";
import { inspectCache } from "./cache.mjs";
import { readJSON } from "./files.mjs";
import { inspectHost } from "./host.mjs";
import { pnpmRoot } from "./pnpm.mjs";
import { checked, executable, launcherScript } from "./process.mjs";

export async function resolveVersion(options, runtime, runnerVersion) {
  if (options.to) return options.to;
  if (!["check", "update"].includes(options.command)) return runnerVersion;
  const stdout = await checked(runtime, "npm", ["view", `${packageName}@latest`, "version", "--json"]);
  let version;
  try { version = JSON.parse(stdout); } catch { throw new SetupError("registry_response", "Registry did not return a JSON version"); }
  if (typeof version !== "string") throw new SetupError("registry_response", "Registry version must be a string");
  exactVersion(version);
  if (version.includes("-")) throw new SetupError("stable_is_prerelease", `Stable registry tag resolves to prerelease ${version}; use --to explicitly`);
  return version;
}

function installedExecutable(runtime, owner) {
  const launcher = path.join(runtime.packageRoot, "bin/cli.cjs");
  if (!fs.existsSync(launcher) || (owner && fs.realpathSync(owner.package_root) === fs.realpathSync(runtime.packageRoot))) return executable("memocap", runtime.env);
  const directories = (runtime.env.PATH || runtime.env.Path || "").split(path.delimiter);
  const runnerLauncher = fs.realpathSync(launcher);
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = executable("memocap", { ...runtime.env, PATH: directory });
    if (!candidate) continue;
    const script = launcherScript(candidate);
    if (!script || fs.realpathSync(script) !== runnerLauncher) return candidate;
  }
  return null;
}

export async function discoverCLI(runtime, options) {
  const owners = [];
  const available = [];
  for (const manager of ["npm", "pnpm"]) {
    const execution = manager === "pnpm" ? { code: 0, stdout: await pnpmRoot(runtime) || "" } : await runtime.run(manager, ["root", "--global"], { env: runtime.env, cwd: runtime.cwd });
    if (execution.code !== 0) continue;
    const root = execution.stdout.trim();
    if (!root) continue;
    if (!path.isAbsolute(root)) throw new SetupError("manager_root", `${manager} did not return an absolute package root`);
    available.push(manager);
    const packageRoot = path.join(root, packageName);
    const metadata = readJSON(path.join(packageRoot, "package.json"));
    if (metadata) {
      if (metadata.name !== packageName) throw new SetupError("package_identity", packageRoot);
      owners.push({ manager, package_root: packageRoot, version: exactVersion(metadata.version) });
    }
  }
  if (owners.length > 1) throw new SetupError("duplicate_managers", "memocap is installed by multiple managers; choose and remove the duplicate explicitly", owners);
  const owner = owners[0];
  if (owner && options.manager && owner.manager !== options.manager) throw new SetupError("manager_conflict", `Existing owner is ${owner.manager}; refusing a duplicate ${options.manager} install`);
  const executablePath = installedExecutable(runtime, owner);
  if (!owner && executablePath) throw new SetupError("unowned_cli", `Cannot prove package-manager ownership of ${executablePath}`);
  if (owner && executablePath) {
    const metadata = readJSON(path.join(owner.package_root, "package.json"));
    const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.memocap;
    const expected = bin && path.resolve(owner.package_root, bin);
    const actual = launcherScript(executablePath);
    if (!expected || !fs.existsSync(expected) || !actual || fs.realpathSync(expected) !== fs.realpathSync(actual)) throw new SetupError("unowned_cli", `PATH launcher does not belong to ${owner.manager}'s memocap package: ${executablePath}`);
  }
  return { scope: "current_user", manager: owner?.manager || options.manager || "npm", available_managers: available, package_root: owner?.package_root || null,
    version: owner?.version || null, executable_path: executablePath, executable_version: null, binary_status: "not_run", cache: inspectCache(runtime, owner?.version) };
}

export function refuseDowngrade(current, target) {
  if (current && compareVersions(current, target) > 0) throw new SetupError("downgrade_refused", `Installed ${current} is newer than ${target}`);
}

export function cliInstallArguments(manager, target) {
  return [manager === "pnpm" ? "add" : "install", "--global", `${packageName}@${target}`];
}

export async function installCLI(context) {
  const { runtime, target, report } = context;
  const current = report.shared_cli;
  const needed = current.version !== target || !current.executable_path;
  let execution = null;
  if (needed) {
    execution = await runtime.run(current.manager, cliInstallArguments(current.manager, target), { cwd: runtime.cwd, env: runtime.env });
  }
  const observed = await discoverCLI(runtime, context.options);
  report.shared_cli = observed;
  if (observed.version !== target || !observed.executable_path) throw new SetupError(execution?.code ? "cli_outcome_unknown" : "cli_readback", "CLI package/executable did not match the fixed target", { execution, observed });
  const version = await checked(runtime, observed.executable_path, ["--version"]);
  observed.executable_version = version.replace(/^memocap /, "");
  if (version !== `memocap ${target}` && version !== target) throw new SetupError("cli_version_mismatch", `Actual executable returned ${version}`, observed);
  observed.binary_status = "verified";
  observed.cache = inspectCache(runtime, target);
  return { status: needed ? "changed" : "unchanged", observed, recovered_after_error: Boolean(execution?.code) };
}

export async function prerequisites(runtime) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 20)) throw new SetupError("node_version", "Node >=22.20.0 is required");
  if (!["linux/x64", "darwin/arm64", "win32/x64"].includes(`${runtime.platform}/${runtime.arch}`)) throw new SetupError("unsupported_platform", `${runtime.platform}/${runtime.arch}`);
  const host = inspectHost(runtime);
  if (host.version && host.version !== "1.19.3") throw new SetupError("unsupported_host", `Verified OpenCode version is 1.19.3; found ${host.version}`);
  await checked(runtime, "git", ["--version"]);
  return { node: process.versions.node, platform: `${runtime.platform}/${runtime.arch}`, opencode: host.version, host };
}

export async function removeCLI(context) {
  const current = context.report.shared_cli;
  if (!current.version) return { status: "unchanged" };
  if (Object.keys(context.manifest.installs).length) throw new SetupError("cli_references_remain", "Preserving shared CLI because installation references remain");
  const execution = await context.runtime.run(current.manager, [current.manager === "npm" ? "uninstall" : "remove", "--global", packageName], { env: context.runtime.env, cwd: context.runtime.cwd });
  const observed = await discoverCLI(context.runtime, context.options);
  if (observed.version) throw new SetupError("cli_remove_failed", "CLI remains installed", { execution, observed });
  context.report.shared_cli = observed;
  return { status: "changed", observed };
}
