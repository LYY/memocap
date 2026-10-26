"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const crypto = require("node:crypto");
const { fixture, failPolicyCopy } = require("./setup-fixtures.cjs");

test("upgrade changes only the source token of plugin tuple preserving option comments", async (context) => {
  const f = fixture(context);
  f.installCLI("0.0.10");
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, '{"plugin": [["@lyy-gh/memocap@0.0.10", {\n// option comment\n"automatic": false}]]}\n');
  const report = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(fs.readFileSync(f.config, "utf8").includes("// option comment"), true);
});

test("failed copy reports missing plugin without exposing a partial policy", async (context) => {
  const f = fixture(context);
  failPolicyCopy(context);
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 1);
  assert.equal(report.scopes[0].plugin.status, "missing");
  assert.equal(fs.existsSync(f.config), false);
  assert.equal(report.scopes[0].skill.status, "missing");
});

test("uninstall still works after the user has removed the OpenCode host", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  f.state.fail = (command) => command === "opencode";
  const report = await f.setup(["uninstall", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config)).plugin, []);
});

test("dry-run refuses a modified canonical skill reachable through a config symlink", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  const canonical = f.managedPath();
  fs.mkdirSync(path.join(path.dirname(f.config), "skills"), { recursive: true });
  fs.symlinkSync(canonical, path.join(path.dirname(f.config), "skills/memocap"), "dir");
  fs.appendFileSync(path.join(canonical, "SKILL.md"), "changed\n");
  const report = await f.setup(["update", "--to", "0.1.0", "--dry-run"]);
  assert.equal(report.error.code, "skill_modified");
  assert.equal(fs.lstatSync(path.join(path.dirname(f.config), "skills/memocap")).isSymbolicLink(), true);
});

test("a second discoverable copy conflicts even if one owned copy is unchanged", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  const duplicate = path.join(path.dirname(f.config), "skills/memocap");
  fs.mkdirSync(path.dirname(duplicate), { recursive: true });
  fs.cpSync(f.managedPath(), duplicate, { recursive: true });
  const report = await f.setup(["update", "--to", "0.1.0", "--dry-run"]);
  assert.equal(report.error.code, "duplicate_skill");
});

test("check reports configuration drift with nonzero exit without writing anything", async (context) => {
  const f = fixture(context);
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  const text = JSON.stringify({ command: { memory: { template: "custom" } } });
  fs.writeFileSync(f.config, text);
  const report = await f.setup(["check"]);
  assert.equal(report.exit_code, 1);
  assert.equal(report.error.code, "memory_command_conflict");
  assert.equal(fs.readFileSync(f.config, "utf8"), text);
});

test("a skill edit made during package update is preserved instead of overwritten", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  fs.writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.2.0" }));
  fs.appendFileSync(path.join(f.packageRoot, "skills/memocap/SKILL.md"), "new release\n");
  const skillFile = path.join(f.managedPath(), "SKILL.md");
  f.state.afterCommand = (_command, args) => { if (args[0] === "install") fs.appendFileSync(skillFile, "concurrent user edit\n"); };
  const report = await f.setup(["update", "--to", "0.2.0", "--yes"]);
  assert.equal(report.error?.code, "skill_modified");
  assert.equal(fs.readFileSync(skillFile, "utf8").endsWith("concurrent user edit\n"), true);
});

test("all explicitly included global and project scopes upgrade as one fixed-version set", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  const project = await f.setup(["install", "--project", f.project, "--yes"]);
  assert.equal(project.exit_code, 0, JSON.stringify(project));
  fs.writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.2.0" }));
  fs.appendFileSync(path.join(f.packageRoot, "skills/memocap/SKILL.md"), "new release\n");
  const report = await f.setup(["update", "--to", "0.2.0", "--global", "--project", f.project, "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.shared_cli.executable_version, "0.2.0");
  assert.equal(report.scopes.every((scope) => scope.plugin.entries[0][0] === "@lyy-gh/memocap@0.2.0" && scope.skill.source.version === "0.2.0"), true);
  assert.equal(report.scopes[1].owner_reused, true);
});

test("doctor checks cached binary integrity and only executes readonly backend inspections", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  const directory = path.join(f.home, "Library/Caches/memocap/0.1.0");
  fs.mkdirSync(directory, { recursive: true });
  const name = "memocap-aarch64-apple-darwin";
  fs.writeFileSync(path.join(directory, name), "verified binary bytes");
  fs.writeFileSync(path.join(directory, `${name}.sha256`), `${crypto.createHash("sha256").update("verified binary bytes").digest("hex")}  ${name}\n`);
  f.calls.length = 0;
  const report = await f.setup(["doctor"]);
  assert.equal(report.shared_cli.cache.status, "verified");
  assert.equal(f.calls.filter((call) => path.isAbsolute(call.command)).every((call) => call.args[0] === "--version" || call.args.join(" ") === "status --read-only --json"), true);
  fs.writeFileSync(path.join(directory, name), "corrupted binary bytes");
  const corrupted = await f.setup(["doctor"]);
  assert.equal(corrupted.exit_code, 1);
  assert.equal(corrupted.shared_cli.cache.status, "invalid");
});

test("read-only planning never starts OpenCode merely to query its version", async (context) => {
  const f = fixture(context);
  const report = await f.setup(["install", "--dry-run", "--json"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(f.calls.some((call) => call.command === "opencode"), false);
});

test("read-only planning does not ask pnpm global root to create an absent bin directory", async (context) => {
  const f = fixture(context);
  f.state.manager = "pnpm";
  const report = await f.setup(["install", "--dry-run"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(f.calls.some((call) => call.command === "pnpm" && call.args[0] === "root"), false);
});

test("disabled external skills leave the managed explicit path discoverable", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  f.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
  const report = await f.setup(["doctor"]);
  assert.equal(report.scopes[0].skill.status, "discovered");
  assert.equal(report.scopes[0].skill.installed.discovery_path, f.managedPath());
});
