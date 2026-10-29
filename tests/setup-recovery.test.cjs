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

test("a lost policy publication response reconciles actual files without replaying the copy", async (context) => {
  const f = fixture(context);
  const rename = fs.renameSync;
  let publications = 0;
  context.mock.method(fs, "renameSync", (source, destination) => {
    const outcome = rename(source, destination);
    if (String(source).includes(".memocap-policy-")) { publications++; throw Object.assign(new Error("publication response lost"), { code: "EIO" }); }
    return outcome;
  });
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(publications, 1);
  assert.equal(fs.existsSync(path.join(f.managedPath(), "SKILL.md")), true);
  assert.equal(f.calls.some((call) => call.command === "npx"), false);
});

test("same-version repair restores missing owned plugin and skill", async (context) => {
  const f = fixture(context);
  const initial = await f.setup(["install", "--yes"]);
  assert.equal(initial.exit_code, 0, JSON.stringify(initial));
  const directory = f.managedPath();
  fs.writeFileSync(f.config, '{"model":"keep"}\n');
  fs.rmSync(directory, { recursive: true });
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

test("uninstall retains managed content and CLI when another agent references it", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  const directory = f.managedPath();
  const alias = path.join(f.home, ".codex/skills/memocap");
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.symlinkSync(directory, alias, "dir");
  const before = fs.readFileSync(path.join(directory, "SKILL.md"), "utf8");
  const report = await f.setup(["uninstall", "--remove-cli", "--yes"]);
  assert.equal(report.error.code, "cli_references_remain");
  assert.equal(fs.readFileSync(path.join(directory, "SKILL.md"), "utf8"), before);
  assert.equal(f.calls.some((call) => call.command === "npx" && call.args.includes("remove")), false);
});

test("exact target worker freezes stable once even if registry changes later", async (context) => {
  const f = fixture(context);
  f.state.afterCommand = (_command, args) => { if (args[0] === "install") f.state.stable = "0.2.0"; };
  const report = await f.setup(["update", "--global", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.resolved_version, "0.1.0");
  assert.equal(f.calls.filter((call) => call.args[0] === "view").length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.config)).plugin[0][0], "@lyy-gh/memocap@0.1.0");
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

test("an unmodified unmanaged skill cannot be adopted even with a provenance lock", async (context) => {
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
  assert.equal(report.error?.code, "unowned_skill");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config)).plugin, ["@lyy-gh/memocap@0.0.10"]);
  assert.equal(fs.existsSync(paths.canonical), true);
  assert.equal(f.calls.some(({ args }) => args[0] === "install" || args.includes("prepare")), false);
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
  let installed = false;
  let failed = false;
  f.state.afterCommand = (_command, args) => { if (args[0] === "install") installed = true; };
  const rename = fs.renameSync;
  context.mock.method(fs, "renameSync", (source, destination) => {
    if (installed && !failed && destination === manifest) { failed = true; throw Object.assign(new Error("manifest commit fault"), { code: "EACCES" }); }
    return rename(source, destination);
  });
  const partial = await f.setup(["install", "--yes"]);
  assert.equal(partial.status, "partial");
  assert.equal(partial.steps.find((step) => step.component === "cli").status, "changed");
  assert.equal(partial.steps.find((step) => step.component === "manifest").status, "failed");
  assert.equal(fs.existsSync(path.join(f.prefix, "bin/memocap")), true);
  context.mock.restoreAll();
  f.state.afterCommand = null;
  const repaired = await f.setup(["install", "--yes"]);
  assert.equal(repaired.exit_code, 0, JSON.stringify(repaired));
});

test("backup failure never replaces the original config and permits a scoped retry", async (context) => {
  const f = fixture(context);
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, "{}\n");
  const writeFileSync = fs.writeFileSync;
  let backupWriteFailed = false;
  context.mock.method(fs, "writeFileSync", (filename, ...args) => {
    if (!backupWriteFailed && typeof filename === "string" && filename.startsWith(`${f.config}.memocap-before-`)) {
      backupWriteFailed = true;
      const error = new Error("injected config backup write failure");
      error.code = "EACCES";
      throw error;
    }
    return writeFileSync.call(fs, filename, ...args);
  });
  let partial;
  try { partial = await f.setup(["install", "--yes"]); }
  finally { context.mock.restoreAll(); }
  assert.equal(partial.exit_code, 1);
  assert.equal(partial.error.code, "EACCES");
  assert.equal(fs.readFileSync(f.config, "utf8"), "{}\n");
  const repaired = await f.setup(["install", "--yes"]);
  assert.equal(repaired.exit_code, 0, JSON.stringify(repaired));
  assert.equal(repaired.scopes[0].config, f.config);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config, "utf8")).plugin, [["@lyy-gh/memocap@0.1.0", { skillDirectory: f.managedPath() }]]);
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

test("a provenance lock cannot authorize unmanaged skill mutation without plugin ownership", async (context) => {
  const f = fixture(context);
  f.installCLI("0.0.10");
  const paths = f.skillPaths(f.project, true);
  fs.mkdirSync(paths.canonical, { recursive: true });
  fs.cpSync(path.join(f.packageRoot, "skills/memocap"), paths.canonical, { recursive: true });
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ version: 3, skills: { memocap: { source: "LYY/memocap", sourceType: "github", ref: "v0.0.10", sourceUrl: "https://github.com/LYY/memocap/tree/v0.0.10" } } }));
  const report = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(report.error?.code, "unowned_skill");
  assert.equal(fs.existsSync(report.manifest_path), false);
  assert.equal(fs.existsSync(paths.canonical), true);
});

test("failed local payload removal is reported and a same-target retry completes it", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  const directory = f.managedPath();
  const remove = fs.rmSync;
  context.mock.method(fs, "rmSync", (filename, options) => {
    if (filename === directory) throw Object.assign(new Error("payload removal denied"), { code: "EACCES" });
    return remove(filename, options);
  });
  const report = await f.setup(["uninstall", "--yes"]);
  assert.equal(report.exit_code, 1);
  assert.equal(report.error.code, "EACCES");
  assert.equal(report.steps.find((step) => step.component === "skill_removal").status, "failed");
  assert.equal(fs.existsSync(path.join(directory, "SKILL.md")), true);
  context.mock.restoreAll();
  assert.equal((await f.setup(["uninstall", "--yes"])).exit_code, 0);
  assert.equal(fs.existsSync(directory), false);
});

test("uninstall preserves a payload edited after config removal before payload inspection", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  const filename = path.join(f.managedPath(), "SKILL.md");
  const rename = fs.renameSync;
  context.mock.method(fs, "renameSync", (source, destination) => {
    const outcome = rename(source, destination);
    if (destination === f.config) fs.appendFileSync(filename, "user edit during uninstall\n");
    return outcome;
  });
  const report = await f.setup(["uninstall", "--yes"]);
  assert.equal(report.exit_code, 0);
  assert.equal(report.warnings.some((warning) => warning.code === "skill_modified"), true);
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
