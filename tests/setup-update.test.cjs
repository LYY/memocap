"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

test("check resolves stable once and reports update_available with exit zero", async (context) => {
  const f = fixture(context);
  f.installCLI("0.0.10");
  const report = await f.setup(["check", "--global", "--json"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.update_available, true);
  assert.equal(report.resolved_version, "0.1.0");
  assert.equal(f.calls.filter((call) => call.args[0] === "view").length, 1);
  assert.equal(f.calls.some((call) => call.command === "npx"), false);
});

test("registry failure is failed, never up to date", async (context) => {
  const f = fixture(context);
  f.state.fail = (_command, args) => args[0] === "view";
  const report = await f.setup(["check", "--json"]);
  assert.equal(report.exit_code > 0, true);
  assert.equal(report.update_available, null);
});

test("update refuses downgrade before any write", async (context) => {
  const f = fixture(context);
  f.installCLI("0.2.0");
  const report = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(report.error.code, "downgrade_refused");
  assert.equal(fs.existsSync(f.config), false);
});

test("a worker version mismatch cannot mutate even with yes", async (context) => {
  const f = fixture(context);
  const report = await f.setup(["update", "--worker", "--to", "0.2.0", "--yes"]);
  assert.equal(report.error.code, "worker_version_mismatch");
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.config), false);
});

test("new target update delegates to exact worker and never falls back after failure", async (context) => {
  const f = fixture(context);
  const report = await f.setup(["update", "--to", "0.2.0", "--yes"]);
  assert.equal(report.exit_code > 0, true);
  assert.equal(f.calls.some((call) => call.command === "npx" && call.args.includes("@lyy-gh/memocap@0.2.0")), true);
  assert.equal(f.calls.some((call) => call.command === "npm" && call.args[0] === "install"), false);
  assert.equal(fs.existsSync(f.config), false);
});

test("shared CLI references require explicit inclusion in an update", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--global", "--yes"]);
  const project = await f.setup(["install", "--project", f.project, "--yes"]);
  assert.equal(project.exit_code, 0, JSON.stringify(project));
  fs.writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.2.0" }));
  const report = await f.setup(["update", "--to", "0.2.0", "--global", "--yes"]);
  assert.equal(report.error.code, "shared_cli_conflict");
});

test("modified managed skill stops update and survives uninstall", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  const skillFile = path.join(f.skillPaths(f.project, true).canonical, "SKILL.md");
  fs.appendFileSync(skillFile, "user addition\n");
  const update = await f.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(update.error.code, "skill_modified");
  const uninstall = await f.setup(["uninstall", "--yes"]);
  assert.equal(uninstall.exit_code > 0, true);
  assert.equal(fs.readFileSync(skillFile, "utf8").endsWith("user addition\n"), true);
});

test("an unconfirmed update never downloads a target worker", async (context) => {
  const f = fixture(context);
  f.state.stable = "0.2.0";
  const report = await f.setup(["update"]);
  assert.equal(report.error.code, "confirmation_required");
  assert.equal(f.calls.some((call) => call.command === "npx"), false);
});
