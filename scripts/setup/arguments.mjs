import path from "node:path";

export const commands = ["install", "check", "update", "doctor", "uninstall"];
export const packageName = "@lyy-gh/memocap";

export class SetupError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function exactVersion(text) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(text)) {
    throw new SetupError("invalid_version", `Expected an exact semver version: ${text}`);
  }
  return text;
}

export function compareVersions(left, right) {
  const [leftCore, leftPre] = left.split(/-(.*)/s);
  const [rightCore, rightPre] = right.split(/-(.*)/s);
  const numeric = leftCore.split(".").map(Number);
  const other = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (numeric[index] !== other[index]) return Math.sign(numeric[index] - other[index]);
  if (leftPre === rightPre) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  const parts = leftPre.split(".");
  const others = rightPre.split(".");
  for (let index = 0; index < Math.max(parts.length, others.length); index++) {
    if (parts[index] === others[index]) continue;
    if (parts[index] === undefined) return -1;
    if (others[index] === undefined) return 1;
    const firstNumeric = /^\d+$/.test(parts[index]);
    const secondNumeric = /^\d+$/.test(others[index]);
    if (firstNumeric && secondNumeric) return Math.sign(Number(parts[index]) - Number(others[index]));
    if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1;
    return parts[index] < others[index] ? -1 : 1;
  }
  return 0;
}

export function parseArguments(argv, cwd) {
  const options = { command: "install", projects: [], global: false, yes: false, dryRun: false, json: false, worker: false, removeCLI: false };
  let offset = 0;
  if (argv[0] && !argv[0].startsWith("--")) {
    options.command = argv[0];
    offset = 1;
  }
  if (!commands.includes(options.command)) throw new SetupError("invalid_command", options.command);
  const booleans = { "--global": "global", "--yes": "yes", "--dry-run": "dryRun", "--json": "json", "--worker": "worker", "--remove-cli": "removeCLI", "--help": "help" };
  for (let index = offset; index < argv.length; index++) {
    const flag = argv[index];
    if (booleans[flag]) { options[booleans[flag]] = true; continue; }
    if (!["--project", "--config", "--to", "--package-manager"].includes(flag) || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new SetupError("invalid_argument", `Unknown option or missing value: ${flag}`);
    }
    const argument = argv[++index];
    switch (flag) {
      case "--project": options.projects.push(path.resolve(cwd, argument)); break;
      case "--config": options.config = path.resolve(cwd, argument); break;
      case "--to": options.to = exactVersion(argument); break;
      case "--package-manager": options.manager = argument; break;
    }
  }
  options.projects = [...new Set(options.projects)];
  if (!options.global && !options.projects.length) options.global = true;
  const scopes = Number(options.global) + options.projects.length;
  if ((options.command === "install" || options.config) && scopes !== 1) throw new SetupError("ambiguous_scope", "install/--config requires exactly one scope");
  if (options.manager && !["npm", "pnpm"].includes(options.manager)) throw new SetupError("invalid_manager", "Use npm or pnpm");
  if (options.removeCLI && options.command !== "uninstall") throw new SetupError("invalid_argument", "--remove-cli requires uninstall");
  if (options.worker && !options.to) throw new SetupError("invalid_argument", "Worker requires --to");
  return options;
}
