"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap setup "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const prefix = path.join(root, "prefix");
  const packageRoot = path.join(root, "runner");
  const project = path.join(root, "project with spaces");
  for (const directory of [home, prefix, packageRoot, project]) fs.mkdirSync(directory, { recursive: true });
  const skillText = "---\nname: memocap\ndescription: fixture\n---\n<!-- memocap:begin -->\nfixture release\n<!-- memocap:end -->\n";
  fs.mkdirSync(path.join(packageRoot, "skills/memocap"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "skills/memocap/SKILL.md"), skillText);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.1.0" }));
  const host = path.join(root, "host");
  fs.mkdirSync(path.join(host, "bin"), { recursive: true });
  fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({ name: "opencode-ai", version: "1.19.3" }));
  const hostScript = path.join(host, "bin", process.platform === "win32" ? "opencode.cjs" : "opencode");
  fs.writeFileSync(hostScript, `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(9);\nconsole.log('1.19.3');\n`, { mode: 0o755 });
  if (process.platform === "win32") fs.writeFileSync(path.join(host, "bin/opencode.cmd"), `@echo off\r\n:: cmd-shim-target=${hostScript}\r\n`, { mode: 0o755 });
  const env = {
    HOME: home, USERPROFILE: home, PATH: [path.join(prefix, "bin"), path.join(host, "bin")].join(path.delimiter),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"), LOCALAPPDATA: path.join(home, "local"),
  };
  const calls = [];
  const installed = path.join(prefix, "lib/node_modules/@lyy-gh/memocap");
  const cliScript = path.join(prefix, "bin/memocap");
  const cliPath = process.platform === "win32" ? `${cliScript}.cmd` : cliScript;
  const config = path.join(env.XDG_CONFIG_HOME, "opencode/opencode.jsonc");
  const state = { stable: "0.1.0", fail: null, afterCommand: null, agents: ["OpenCode"], manager: "npm" };
  function installCLI(version) {
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version, bin: { memocap: "fixture-cli.cjs" } }));
    fs.cpSync(path.join(packageRoot, "skills"), path.join(installed, "skills"), { recursive: true });
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    const launcher = path.join(installed, "fixture-cli.cjs");
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    if (cliPath !== cliScript) fs.writeFileSync(cliPath, `@echo off\r\n:: cmd-shim-target=${launcher}\r\n`, { mode: 0o755 });
    if (!fs.existsSync(cliScript)) fs.symlinkSync(launcher, cliScript, "file");
    fs.writeFileSync(launcher, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('memocap ${version}'); process.exit(0); }
const database = process.env.MEMOCAP_DB || path.join(process.env.HOME, '.memocap/memocap.db');
if (args.join(' ') === 'activity prepare --json') {
  fs.mkdirSync(path.dirname(database), {recursive:true}); fs.writeFileSync(database, 'fixture main');
  console.log(JSON.stringify({format_version:1,status:'ok',backend:'local'})); process.exit(0);
}
if (args.join(' ') !== 'status --read-only --json') process.exit(9);
const ready = fs.existsSync(database);
console.log(JSON.stringify({format_version:1,status:'ok',backend:process.env.MEMOCAP_ADDR?'remote':'local',origin:process.env.MEMOCAP_ADDR?'server':'cli',inspection:{
  core_status:ready?'ready':'not_initialized',schema_version:ready?'2.0':null,visible:ready?{schema_version:'2.0',placements:[],addressable_total:0,effective_total:0}:null,activity_status:ready?'ready':'not_initialized',activity_error:null,
  capabilities:['receipt_v1','recall_match','multi_target','inventory','activity','read_only_status','single_database','schema_2_compatible']}}));
`, { mode: 0o755 });
  }
  function skillPaths(cwd, global) {
    const base = global ? home : cwd;
    return { canonical: path.join(base, ".agents/skills/memocap"),
      lock: global ? path.join(env.XDG_STATE_HOME, "skills/.skill-lock.json") : path.join(cwd, "skills-lock.json") };
  }
  async function run(command, args, options = {}) {
    calls.push({ command, args: [...args], cwd: options.cwd });
    if (state.afterCommand) state.afterCommand(command, args);
    if (state.fail?.(command, args)) return { code: 1, stdout: "", stderr: "injected process failure" };
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (command === "git") return ok("git version 2.50.0\n");
    if (command === "npm" || command === "pnpm") {
      if (command !== state.manager && args[0] !== "view") return { code: 1, stdout: "", stderr: "not installed" };
      if (args[0] === "view") return ok(JSON.stringify(state.stable));
      if (args[0] === "--version") return ok("12.14.0\n");
      if (args[0] === "config") return ok(args.at(-1) === "global-bin-dir" ? path.join(prefix, "bin") : path.join(prefix, "global"));
      if (args[0] === "root") return ok(path.join(prefix, "lib/node_modules"));
      if (args[0] === "bin") return ok(path.join(prefix, "bin"));
      if (args[0] === "prefix") return ok(prefix);
      if (["install", "add"].includes(args[0])) {
        installCLI(args.find((arg) => arg.startsWith("@lyy-gh/memocap@")).split("@").at(-1));
        return ok();
      }
      if (["uninstall", "remove"].includes(args[0])) {
        fs.rmSync(installed, { recursive: true, force: true });
        fs.rmSync(path.join(prefix, "bin/memocap"), { force: true });
        if (cliPath !== cliScript) fs.rmSync(cliPath, { force: true });
        return ok();
      }
    }
    if (command === "npx" && args.includes("skills@1.7.4")) {
      throw new Error("skills CLI is not part of managed setup");
    }
    if (path.isAbsolute(command)) {
      const { launcherScript } = await import("../scripts/setup/process.mjs");
      const script = /\.(cmd|bat)$/i.test(command) ? launcherScript(command) : command;
      if (!script) return { code: 126, stdout: "", stderr: `unsupported fixture shim ${command}` };
      const execution = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...env, ...options.env } });
      if (execution.error) throw execution.error;
      return { code: execution.status ?? 1, stdout: execution.stdout || "", stderr: execution.stderr || "" };
    }
    return { code: 1, stdout: "", stderr: `unsupported fixture process ${command} ${args.join(" ")}` };
  }
  const runtime = { env, cwd: project, packageRoot, run, platform: process.platform, arch: process.arch };
  function cacheBinary(version) {
    const base = process.platform === "darwin" ? path.join(home, "Library/Caches")
      : process.platform === "win32" ? env.LOCALAPPDATA : env.XDG_CACHE_HOME;
    const { resolveReleaseAsset } = require("../bin/cli.cjs");
    return path.join(base, "memocap", version, resolveReleaseAsset(process.platform, process.arch).name);
  }
  async function setup(args) {
    const { runSetup } = await import("../scripts/setup/core.mjs");
    return runSetup(args, runtime);
  }
  function managedPath() { return JSON.parse(fs.readFileSync(config)).plugin.find((entry) => Array.isArray(entry) && entry[0].startsWith("@lyy-gh/memocap@"))[1].skillDirectory; }
  return { root, home, prefix, project, packageRoot, config, env, calls, state, installed, cliPath, cliScript, installCLI, skillPaths, managedPath, cacheBinary, runtime, setup };
}

function failPolicyCopy(context) {
  const copy = fs.cpSync;
  context.mock.method(fs, "cpSync", (source, destination, options) => {
    if (String(destination).includes(".memocap-policy-")) throw Object.assign(new Error("injected partial policy copy"), { code: "EACCES" });
    return copy(source, destination, options);
  });
}

module.exports = { fixture, failPolicyCopy };
