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
  const skillText = "---\nname: memocap\ndescription: fixture\n---\nfixture release\n";
  fs.mkdirSync(path.join(packageRoot, "skills/memocap"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "skills/memocap/SKILL.md"), skillText);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.1.0" }));
  const host = path.join(root, "host");
  fs.mkdirSync(path.join(host, "bin"), { recursive: true });
  fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({ name: "opencode-ai", version: "1.19.3" }));
  fs.writeFileSync(path.join(host, "bin/opencode"), "fixture host\n", { mode: 0o755 });
  const env = {
    HOME: home, USERPROFILE: home, PATH: [path.join(prefix, "bin"), path.join(host, "bin")].join(path.delimiter),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"), LOCALAPPDATA: path.join(home, "local"),
  };
  const calls = [];
  const installed = path.join(prefix, "lib/node_modules/@lyy-gh/memocap");
  const config = path.join(env.XDG_CONFIG_HOME, "opencode/opencode.jsonc");
  const state = { stable: "0.1.0", fail: null, afterCommand: null, agents: ["OpenCode"], manager: "npm" };
  function installCLI(version) {
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version }));
    fs.cpSync(path.join(packageRoot, "skills"), path.join(installed, "skills"), { recursive: true });
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.writeFileSync(path.join(prefix, "bin/memocap"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('memocap ${version}'); process.exit(0); }
const database = process.env.MEMOCAP_DB || path.join(process.env.HOME, '.memocap/memocap.db');
const auxiliary = database + '.activity.sqlite';
if (args.join(' ') === 'activity prepare --json') {
  fs.mkdirSync(path.dirname(auxiliary), {recursive:true}); fs.writeFileSync(auxiliary, 'fixture auxiliary');
  console.log(JSON.stringify({format_version:1,status:'ok',backend:'local'})); process.exit(0);
}
if (args.join(' ') !== 'status --read-only --json') process.exit(9);
console.log(JSON.stringify({format_version:1,status:'ok',backend:process.env.MEMOCAP_ADDR?'remote':'local',origin:'cli',inspection:{
  core_status:'not_initialized',schema_version:null,visible:null,activity_status:fs.existsSync(auxiliary)?'ready':'not_initialized',activity_error:null,
  capabilities:['receipt_v1','recall_match','multi_target','inventory','activity','read_only_status']}}));
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
    if (command === "opencode") return ok("1.19.3\n");
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
        return ok();
      }
    }
    if (command === "npx" && args.includes("skills@1.7.4")) {
      const global = args.includes("--global");
      const paths = skillPaths(options.cwd || project, global);
      if (args.includes("list")) {
        const present = fs.existsSync(path.join(paths.canonical, "SKILL.md"));
        const metadata = fs.existsSync(paths.lock) ? JSON.parse(fs.readFileSync(paths.lock)).skills.memocap : null;
        return ok(JSON.stringify(present ? [{ name: "memocap", path: paths.canonical,
          scope: global ? "global" : "project", agents: state.agents,
          source: metadata?.source ?? null, sourceUrl: metadata?.sourceUrl ?? null, sourceType: metadata?.sourceType ?? null }] : []));
      }
      if (args.includes("add")) {
        fs.mkdirSync(path.dirname(paths.canonical), { recursive: true });
        fs.cpSync(path.join(packageRoot, "skills/memocap"), paths.canonical, { recursive: true });
        const sourceUrl = args[args.indexOf("add") + 1];
        fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
        fs.writeFileSync(paths.lock, JSON.stringify({ version: global ? 3 : 1, skills: {
          memocap: { source: "LYY/memocap", sourceUrl, sourceType: "github", ref: sourceUrl.split("/").at(-1) },
        } }));
        return ok();
      }
      if (args.includes("remove")) {
        if (state.agents.some((agent) => agent !== "OpenCode")) return { code: 1, stdout: "", stderr: "shared" };
        fs.rmSync(paths.canonical, { recursive: true, force: true });
        return ok();
      }
    }
    if (path.isAbsolute(command)) {
      const execution = spawnSync(command, args, { encoding: "utf8", env: { ...env, ...options.env } });
      return { code: execution.status ?? 1, stdout: execution.stdout || "", stderr: execution.stderr || "" };
    }
    return { code: 1, stdout: "", stderr: `unsupported fixture process ${command} ${args.join(" ")}` };
  }
  const runtime = { env, cwd: project, packageRoot, run, platform: "darwin", arch: "arm64" };
  async function setup(args) {
    const { runSetup } = await import("../scripts/setup/core.mjs");
    return runSetup(args, runtime);
  }
  return { root, home, prefix, project, packageRoot, config, env, calls, state, installed, installCLI, skillPaths, runtime, setup };
}

module.exports = { fixture };
