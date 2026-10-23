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

test("core installs a local packed fixture through a real isolated npm prefix and reads the executable", async (context) => {
  const f = fixture(context);
  const { runProcess } = await import("../scripts/setup/process.mjs");
  fs.mkdirSync(path.join(f.packageRoot, "bin"));
  const cliSource = `#!${process.execPath}
if (process.argv[2] === '--version') console.log('memocap 0.1.0');
else console.log(JSON.stringify({format_version:1,status:'ok',backend:'local',origin:'cli',inspection:{core_status:'not_initialized',schema_version:null,visible:null,activity_status:'ready',activity_error:null,capabilities:['receipt_v1','recall_match','multi_target','inventory','activity','read_only_status']}}));
`;
  fs.writeFileSync(path.join(f.packageRoot, "bin/cli.cjs"), cliSource, { mode: 0o755 });
  const cache = path.join(f.home, "Library/Caches/memocap/0.1.0");
  fs.mkdirSync(cache, { recursive: true });
  const binary = path.join(cache, "memocap-aarch64-apple-darwin");
  fs.writeFileSync(binary, cliSource, { mode: 0o755 });
  fs.writeFileSync(`${binary}.sha256`, `${crypto.createHash("sha256").update(cliSource).digest("hex")}  memocap-aarch64-apple-darwin\n`);
  fs.writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.1.0", bin: { memocap: "bin/cli.cjs" }, files: ["bin", "skills"] }));
  const env = { ...f.env, PATH: [path.join(f.prefix, "bin"), path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter),
    npm_config_prefix: f.prefix, npm_config_cache: path.join(f.root, "npm-cache"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
  const packed = await runProcess("npm", ["pack", "--json", "--ignore-scripts"], { cwd: f.packageRoot, env });
  assert.equal(packed.code, 0, packed.stderr);
  const tarball = path.join(f.packageRoot, JSON.parse(packed.stdout)[0].filename);
  const seam = f.runtime.run;
  f.runtime.env = env;
  f.runtime.run = (command, args, options) => {
    if (command === "pnpm") return Promise.resolve({ code: 127, stdout: "", stderr: "not installed in sandbox" });
    if (command === "npm") return runProcess(command, args[0] === "install" ? ["install", "--global", tarball, "--ignore-scripts", "--no-audit", "--no-fund"] : args, { ...options, env });
    if (path.isAbsolute(command)) return runProcess(command, args, { ...options, env });
    return seam(command, args, options);
  };
  const report = await f.setup(["install", "--yes", "--json"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.shared_cli.executable_version, "0.1.0");
  assert.equal(fs.lstatSync(path.join(f.prefix, "bin/memocap")).isSymbolicLink(), true);
  const repeat = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(repeat.status, "unchanged", JSON.stringify(repeat));
});

test("a timed-out process that ignores termination is killed instead of hanging setup", async () => {
  const { runProcess } = await import("../scripts/setup/process.mjs");
  const execution = await runProcess(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 1500);'], { timeout: 150 });
  assert.equal(execution.signal, "SIGKILL");
  assert.equal(execution.code, 1);
});
