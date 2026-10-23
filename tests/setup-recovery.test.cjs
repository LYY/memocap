"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

test("a concurrent config edit survives partial installation and is reported", async (context) => {
  const f = fixture(context);
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, "{}\n");
  f.state.afterCommand = (_command, args) => {
    if (args[0] === "install") fs.writeFileSync(f.config, '{"model":"concurrent/user"}\n');
  };
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.error.code, "concurrent_change");
  assert.equal(report.status, "partial");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config)), { model: "concurrent/user" });
});

test("a lost package response is reconciled with actual executable version before continuing", async (context) => {
  const f = fixture(context);
  const run = f.runtime.run;
  f.runtime.run = async (command, args, options) => {
    const execution = await run(command, args, options);
    return command === "npm" && args[0] === "install" ? { ...execution, code: 1, stderr: "connection lost after commit" } : execution;
  };
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.steps.find((step) => step.component === "cli").recovered_after_error, true);
  assert.equal(report.shared_cli.executable_version, "0.1.0");
});

test("a lost skill response reconciles actual files and lock instead of replaying add", async (context) => {
  const f = fixture(context);
  const run = f.runtime.run;
  f.runtime.run = async (command, args, options) => {
    const execution = await run(command, args, options);
    return command === "npx" && args.includes("add") ? { ...execution, code: 1, stderr: "connection lost after commit" } : execution;
  };
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.steps.find((step) => step.component === "skill").recovered_after_error, true);
  assert.equal(f.calls.filter((call) => call.command === "npx" && call.args.includes("add")).length, 1);
});

test("same-version repair restores missing owned plugin and skill", async (context) => {
  const f = fixture(context);
  const initial = await f.setup(["install", "--yes"]);
  assert.equal(initial.exit_code, 0, JSON.stringify(initial));
  fs.writeFileSync(f.config, '{"model":"keep"}\n');
  fs.rmSync(f.skillPaths(f.project, true).canonical, { recursive: true });
  const report = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(JSON.parse(fs.readFileSync(f.config)).model, "keep");
  assert.equal(report.steps.find((step) => step.component === "plugin").status, "changed");
  assert.equal(report.steps.find((step) => step.component === "skill").status, "changed");
});

test("a coherent same-version update leaves manifest and config bytes unchanged", async (context) => {
  const f = fixture(context);
  const initial = await f.setup(["install", "--yes"]);
  const before = fs.readFileSync(initial.manifest_path, "utf8");
  const report = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.status, "unchanged");
  assert.equal(fs.readFileSync(initial.manifest_path, "utf8"), before);
});

test("pnpm ownership is reused and explicitly switching managers conflicts", async (context) => {
  const f = fixture(context);
  f.state.manager = "pnpm";
  f.installCLI("0.0.10");
  const refused = await f.setup(["install", "--package-manager", "npm", "--yes"]);
  assert.equal(refused.error.code, "manager_conflict");
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.shared_cli.manager, "pnpm");
  assert.equal(f.calls.some((call) => call.command === "npm" && call.args[0] === "install"), false);
});

test("user changes to managed plugin options are preserved without package writes", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  fs.writeFileSync(f.config, JSON.stringify({ plugin: [["@lyy-gh/memocap@0.1.0", { automatic: false }]] }));
  f.calls.length = 0;
  const report = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(report.error.code, "plugin_modified");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config)).plugin[0][1], { automatic: false });
  assert.equal(f.calls.some((call) => call.args[0] === "install"), false);
});

test("uninstall retains skill content and CLI when another agent shares canonical files", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  f.state.agents = ["OpenCode", "Codex"];
  const before = fs.readFileSync(path.join(f.skillPaths(f.project, true).canonical, "SKILL.md"), "utf8");
  const report = await f.setup(["uninstall", "--remove-cli", "--yes"]);
  assert.equal(report.error.code, "cli_references_remain");
  assert.equal(fs.readFileSync(path.join(f.skillPaths(f.project, true).canonical, "SKILL.md"), "utf8"), before);
  assert.equal(f.calls.some((call) => call.command === "npx" && call.args.includes("remove")), false);
});

test("exact target worker freezes stable once even if registry changes later", async (context) => {
  const f = fixture(context);
  f.state.afterCommand = (_command, args) => { if (args[0] === "install") f.state.stable = "0.2.0"; };
  const report = await f.setup(["update", "--global", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.resolved_version, "0.1.0");
  assert.equal(f.calls.filter((call) => call.args[0] === "view").length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.config)).plugin[0], "@lyy-gh/memocap@0.1.0");
});

test("stable prerelease is refused while explicit prerelease dry-run can plan", async (context) => {
  const f = fixture(context);
  f.state.stable = "0.2.0-beta.1";
  const report = await f.setup(["check"]);
  assert.equal(report.error.code, "stable_is_prerelease");
  const planned = await f.setup(["update", "--to", "0.2.0-beta.1", "--dry-run"]);
  assert.equal(planned.exit_code, 0, JSON.stringify(planned));
  assert.equal(planned.resolved_version, "0.2.0-beta.1");
});

test("an unmodified release-proven 0.0.10 skill and plugin can be adopted", async (context) => {
  const f = fixture(context);
  f.installCLI("0.0.10");
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, JSON.stringify({ plugin: ["@lyy-gh/memocap@0.0.10"] }));
  const paths = f.skillPaths(f.project, true);
  fs.mkdirSync(path.dirname(paths.canonical), { recursive: true });
  fs.cpSync(path.join(f.installed, "skills/memocap"), paths.canonical, { recursive: true });
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ version: 3, skills: { memocap: {
    source: "LYY/memocap", sourceUrl: "https://github.com/LYY/memocap/tree/v0.0.10", sourceType: "github", ref: "v0.0.10",
  } } }));
  const report = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(JSON.parse(fs.readFileSync(f.config)).plugin[0], "@lyy-gh/memocap@0.1.0");
});

test("explicit remove-cli succeeds only after final owned references disappear", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  const report = await f.setup(["uninstall", "--remove-cli", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(fs.existsSync(path.join(f.prefix, "bin/memocap")), false);
});

test("manifest failure preserves and reports the CLI mutation before a successful retry", async (context) => {
  const f = fixture(context);
  const manifest = path.join(f.env.XDG_STATE_HOME, "memocap/setup.json");
  f.state.afterCommand = (_command, args) => {
    if (args[0] === "install") fs.mkdirSync(manifest, { recursive: true });
  };
  const partial = await f.setup(["install", "--yes"]);
  assert.equal(partial.status, "partial");
  assert.equal(partial.steps.find((step) => step.component === "cli").status, "changed");
  assert.equal(partial.steps.find((step) => step.component === "manifest").status, "failed");
  assert.equal(fs.existsSync(path.join(f.prefix, "bin/memocap")), true);
  fs.rmdirSync(manifest);
  f.state.afterCommand = null;
  const repaired = await f.setup(["install", "--yes"]);
  assert.equal(repaired.exit_code, 0, JSON.stringify(repaired));
});

test("backup failure never replaces the original config and permits a scoped retry", async (context) => {
  const f = fixture(context);
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, "{}\n");
  fs.chmodSync(path.dirname(f.config), 0o500);
  let partial;
  try { partial = await f.setup(["install", "--yes"]); }
  finally { fs.chmodSync(path.dirname(f.config), 0o700); }
  assert.equal(partial.exit_code, 1);
  assert.equal(fs.readFileSync(f.config, "utf8"), "{}\n");
  const repaired = await f.setup(["install", "--yes"]);
  assert.equal(repaired.exit_code, 0, JSON.stringify(repaired));
});

test("a failed binary verification reports the package actually installed and a partial mutation", async (context) => {
  const f = fixture(context);
  const run = f.runtime.run;
  f.runtime.run = async (command, args, options) => {
    const execution = await run(command, args, options);
    if (command === "npm" && args[0] === "install") fs.writeFileSync(path.join(f.prefix, "bin/memocap"), `#!${process.execPath}\nconsole.log('memocap 0.0.10');\n`, { mode: 0o755 });
    return execution;
  };
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.status, "partial");
  assert.equal(report.shared_cli.version, "0.1.0");
  assert.equal(report.shared_cli.executable_version, "0.0.10");
  assert.equal(report.error.code, "cli_version_mismatch");
  assert.equal(report.steps.find((step) => step.component === "plugin").status, "not_run");
});

test("adoption reports the release source and content proof persisted in the manifest", async (context) => {
  const f = fixture(context);
  f.installCLI("0.0.10");
  const paths = f.skillPaths(f.project, true);
  fs.mkdirSync(paths.canonical, { recursive: true });
  fs.cpSync(path.join(f.packageRoot, "skills/memocap"), paths.canonical, { recursive: true });
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ version: 3, skills: { memocap: { source: "LYY/memocap", sourceType: "github", ref: "v0.0.10", sourceUrl: "https://github.com/LYY/memocap/tree/v0.0.10" } } }));
  const report = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.ok(report.scopes[0].adoption);
  assert.equal(report.scopes[0].adoption.skill.ref, "v0.0.10");
  assert.equal(typeof report.scopes[0].adoption.skill.fingerprint, "string");
  const manifest = JSON.parse(fs.readFileSync(report.manifest_path));
  assert.equal(manifest.installs[report.scopes[0].id].adoption.skill.source, "LYY/memocap");
});

test("failed scoped removal is detected from actual discovery even when skills list has no agents", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  f.state.agents = [];
  f.state.fail = (command, args) => command === "npx" && args.includes("remove");
  const report = await f.setup(["uninstall", "--yes"]);
  assert.equal(report.exit_code, 1);
  assert.equal(report.error.code, "skill_remove_failed");
  assert.equal(report.steps.find((step) => step.component === "skill").status, "failed");
  assert.equal(fs.existsSync(path.join(f.home, ".agents/skills/memocap/SKILL.md")), true);
});

test("uninstall preserves a skill edited while dependency inventory is being read", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  const filename = path.join(f.home, ".agents/skills/memocap/SKILL.md");
  f.state.afterCommand = (command, args) => {
    if (command === "npx" && args.includes("list")) fs.appendFileSync(filename, "user edit during uninstall\n");
  };
  const report = await f.setup(["uninstall", "--yes"]);
  assert.equal(report.exit_code, 1);
  assert.equal(report.error.code, "skill_modified");
  assert.equal(fs.readFileSync(filename, "utf8").endsWith("user edit during uninstall\n"), true);
});

test("an update backs up existing config and manifest before the package manager mutation", async (context) => {
  const f = fixture(context);
  const installed = await f.setup(["install", "--yes"]);
  f.installCLI("0.0.10");
  const before = fs.readdirSync(path.dirname(f.config)).filter((name) => name.includes("memocap-before"));
  let backedUp = false;
  f.state.afterCommand = (command, args) => {
    if (command === "npm" && args[0] === "install") {
      const current = fs.readdirSync(path.dirname(f.config)).filter((name) => name.includes("memocap-before"));
      backedUp = current.length > before.length && fs.readdirSync(path.dirname(installed.manifest_path)).some((name) => name.startsWith("setup.json.memocap-before"));
    }
  };
  const report = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(backedUp, true);
});

test("a manifest edit made during a package mutation is preserved by the digest check", async (context) => {
  const f = fixture(context);
  const installed = await f.setup(["install", "--yes"]);
  f.installCLI("0.0.10");
  f.state.afterCommand = (command, args) => {
    if (command === "npm" && args[0] === "install") {
      const manifest = JSON.parse(fs.readFileSync(installed.manifest_path));
      manifest.user_marker = "keep";
      fs.writeFileSync(installed.manifest_path, JSON.stringify(manifest));
    }
  };
  const report = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(report.exit_code, 1);
  assert.equal(report.error.code, "manifest_write_failed");
  assert.equal(JSON.parse(fs.readFileSync(installed.manifest_path)).user_marker, "keep");
});
