"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

test("shell wrapper preserves spaced paths and the core exit code", (context) => {
  const f = fixture(context);
  const scripts = path.join(f.root, "wrapper with spaces");
  fs.mkdirSync(scripts);
  fs.copyFileSync(path.resolve(__dirname, "../scripts/install.sh"), path.join(scripts, "install.sh"));
  fs.writeFileSync(path.join(scripts, "setup.mjs"), 'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 23;\n');
  const args = ["install", "--project", f.project, "quote'\"$() ; with spaces"];
  const execution = spawnSync("sh", [path.join(scripts, "install.sh"), ...args], { encoding: "utf8" });
  assert.equal(execution.status, 23, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout), args);
});

test("real core emits one JSON envelope for invalid arguments", () => {
  const execution = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/setup.mjs"), "install", "--unknown", "--json"], { encoding: "utf8" });
  assert.equal(execution.status, 1);
  const report = JSON.parse(execution.stdout);
  assert.equal(report.error.code, "invalid_argument");
  assert.equal(report.steps.length, 0);
});

test("Windows resolves npm Node shims before extensionless shell launchers and preserves literal arguments", async (context) => {
  const f = fixture(context);
  const { executable, runProcess } = await import("../scripts/setup/process.mjs");
  const directory = path.join(f.root, "tools with spaces");
  fs.mkdirSync(directory);
  const scripts = { npm: "node_modules/npm/bin/npm-cli.js", npx: "node_modules/npm/bin/npx-cli.js", pnpm: "node_modules/pnpm/bin/pnpm.cjs", memocap: "node_modules/@lyy-gh/memocap/bin/cli.cjs" };
  for (const [name, script] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(directory, name), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    fs.writeFileSync(path.join(directory, `${name}.cmd`), "@echo off\r\n", { mode: 0o755 });
    fs.mkdirSync(path.dirname(path.join(directory, script)), { recursive: true });
    fs.writeFileSync(path.join(directory, script), "console.log(JSON.stringify(process.argv.slice(2)))");
  }
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    for (const name of Object.keys(scripts)) {
      const env = { ...f.env, Path: directory };
      delete env.PATH;
      assert.equal(executable(name, env), path.join(directory, `${name}.cmd`));
      const args = ["quote'\"$() & ; literal", "path with spaces"];
      const execution = await runProcess(name, args, { env });
      assert.equal(execution.code, 0, execution.stderr);
      assert.deepEqual(JSON.parse(execution.stdout), args);
    }
  } finally { Object.defineProperty(process, "platform", platform); }
});

test("core installs a local packed fixture through a real isolated npm prefix and reads the executable", async (context) => {
  const f = fixture(context);
  const { runProcess, executable } = await import("../scripts/setup/process.mjs");
  fs.mkdirSync(path.join(f.packageRoot, "bin"));
  const cliSource = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const database = process.env.MEMOCAP_DB || path.join(process.env.HOME, '.memocap/memocap.db');
if (process.argv[2] === '--version') console.log('memocap 0.1.0');
else if (process.argv.includes('prepare')) { fs.mkdirSync(path.dirname(database),{recursive:true}); fs.writeFileSync(database,'fixture main'); console.log(JSON.stringify({format_version:1,status:'ok'})); }
else { const ready=fs.existsSync(database); console.log(JSON.stringify({format_version:1,status:'ok',backend:'local',origin:'cli',inspection:{core_status:ready?'ready':'not_initialized',schema_version:ready?'2.0':null,visible:ready?{schema_version:'2.0',placements:[],addressable_total:0,effective_total:0}:null,activity_status:ready?'ready':'not_initialized',activity_error:null,capabilities:['receipt_v1','recall_match','multi_target','inventory','activity','read_only_status','single_database','schema_2_compatible']}})); }
`;
  fs.writeFileSync(path.join(f.packageRoot, "bin/cli.cjs"), cliSource, { mode: 0o755 });
  const cache = path.dirname(f.cacheBinary("0.1.0"));
  fs.mkdirSync(cache, { recursive: true });
  const binary = f.cacheBinary("0.1.0");
  fs.writeFileSync(binary, cliSource, { mode: 0o755 });
  fs.writeFileSync(`${binary}.sha256`, `${crypto.createHash("sha256").update(cliSource).digest("hex")}  ${path.basename(binary)}\n`);
  fs.writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.1.0", bin: { memocap: "bin/cli.cjs" }, files: ["bin", "skills"] }));
  const npm = executable("npm", process.env);
  assert.ok(npm, "npm must be installed for the packed lifecycle contract");
  const tools = path.join(f.root, "tools");
  fs.mkdirSync(tools);
  fs.symlinkSync(process.execPath, path.join(tools, process.platform === "win32" ? "node.exe" : "node"));
  const env = { ...f.env, PATH: [f.prefix, f.env.PATH, tools].join(path.delimiter),
    SystemRoot: process.env.SystemRoot, npm_config_userconfig: path.join(f.root, "npmrc"), npm_config_globalconfig: path.join(f.root, "global-npmrc"),
    npm_config_prefix: f.prefix, npm_config_cache: path.join(f.root, "npm-cache"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
  const packed = await runProcess(npm, ["pack", "--json", "--ignore-scripts"], { cwd: f.packageRoot, env });
  assert.equal(packed.code, 0, packed.stderr);
  const tarball = path.join(f.packageRoot, JSON.parse(packed.stdout)[0].filename);
  const seam = f.runtime.run;
  f.runtime.env = env;
  f.runtime.run = (command, args, options) => {
    if (command === "pnpm") return Promise.resolve({ code: 127, stdout: "", stderr: "not installed in sandbox" });
    if (command === "npm") return runProcess(npm, args[0] === "install" ? ["install", "--global", tarball, "--ignore-scripts", "--no-audit", "--no-fund"] : args, { ...options, env });
    if (command === binary) return seam(command, args, { ...options, env });
    if (path.isAbsolute(command)) return runProcess(command, args, { ...options, env });
    return seam(command, args, options);
  };
  const report = await f.setup(["install", "--yes", "--json"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.prerequisites.host.source, fs.realpathSync(path.join(f.root, "host/package.json")));
  assert.equal(report.shared_cli.executable_version, "0.1.0");
  const installedRoot = path.join(f.prefix, process.platform === "win32" ? "node_modules/@lyy-gh/memocap" : "lib/node_modules/@lyy-gh/memocap");
  const installedCLI = path.join(installedRoot, "bin/cli.cjs");
  assert.equal(report.shared_cli.package_root, installedRoot);
  assert.equal(fs.readFileSync(installedCLI, "utf8"), cliSource);
  if (process.platform === "win32") {
    assert.equal(report.shared_cli.executable_path, path.join(f.prefix, "memocap.cmd"));
    assert.equal(fs.statSync(report.shared_cli.executable_path).isFile(), true);
  } else assert.equal(fs.realpathSync(report.shared_cli.executable_path), fs.realpathSync(installedCLI));
  const repeat = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(repeat.status, "unchanged", JSON.stringify(repeat));
});

test("a timed-out process that ignores termination is killed instead of hanging setup", async () => {
  const { runProcess } = await import("../scripts/setup/process.mjs");
  const started = Date.now();
  const execution = await runProcess(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000);'], { timeout: 3000 });
  assert.equal(execution.code, 1);
  const pid = Number(execution.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, "child initialized before the timeout");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.ok(Date.now() - started < 10_000, "termination is bounded");
  if (process.platform === "win32") assert.ok(execution.signal === null || execution.signal === "SIGKILL");
  else assert.equal(execution.signal, "SIGKILL");
});

test("Windows pnpm 12 cmd wrapper dispatches its installed mjs entry without a shell", async (context) => {
  const f = fixture(context);
  const { runProcess } = await import("../scripts/setup/process.mjs");
  const directory = path.join(f.root, "pnpm tools");
  fs.mkdirSync(path.join(directory, "node_modules/pnpm/bin"), { recursive: true });
  fs.writeFileSync(path.join(directory, "pnpm.cmd"), "@echo off\r\nexit /b 99\r\n");
  fs.writeFileSync(path.join(directory, "node_modules/pnpm/bin/pnpm.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const args = ["quote'\"$() & ; literal"];
    const execution = await runProcess(path.join(directory, "pnpm.cmd"), args, { env: f.env });
    assert.equal(execution.code, 0, execution.stderr);
    assert.deepEqual(JSON.parse(execution.stdout), args);
  } finally { Object.defineProperty(process, "platform", platform); }
});
