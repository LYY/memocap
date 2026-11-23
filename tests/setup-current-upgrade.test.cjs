"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { currentFixture } = require("./setup-current-fixture.cjs");

test("managed contract fixture upgrades 0.6 ownership via exact 0.7 worker without schema preparation", async (context) => {
  const setup = await currentFixture(context);
  const before = JSON.parse(fs.readFileSync(setup.env.MEMOCAP_DB));
  const oldSkill = fs.readFileSync(path.join(setup.managedPath(), "SKILL.md"), "utf8");
  const report = await setup.setup(["update", "--to", "0.7.0", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.delegated_worker, true);
  assert.equal(report.bootstrap_runner_version, "0.6.0");
  assert.equal(report.runner_version, "0.7.0");
  assert.equal(report.shared_cli.version, "0.7.0");
  assert.equal(report.shared_cli.executable_version, "0.7.0");
  assert.equal(report.backend.core_schema.observed, "2.3");
  assert.equal(report.backend.activity.status, "ready");
  assert.equal(report.runtime.status, "not_run");
  assert.equal(report.readiness, "static_ready");
  assert.deepEqual(JSON.parse(fs.readFileSync(setup.env.MEMOCAP_DB)), before);
  assert.equal(JSON.parse(fs.readFileSync(report.manifest_path)).format_version, 2);
  const config = JSON.parse(fs.readFileSync(setup.config));
  assert.equal(config.plugin[0][0], "@lyy-gh/memocap@0.7.0");
  assert.equal(config.model, "fixture/model");
  assert.deepEqual(config.custom, { retained: true });
  assert.deepEqual(config.permission, { custom_tool: { "private/*": "deny" }, memocap_recall: { library: "allow" }, memocap_read: { library: "allow" } });
  assert.equal(config.skills.paths.includes(setup.managedPath()), true);
  const newSkill = fs.readFileSync(path.join(setup.managedPath(), "SKILL.md"), "utf8");
  assert.notEqual(newSkill, oldSkill);
  assert.equal(newSkill, fs.readFileSync(path.join(setup.targetRoot, "skills/memocap/SKILL.md"), "utf8"));
  const delegated = setup.calls.findIndex(({ command }) => command === "npx");
  const installed = setup.calls.findIndex(({ command, args }) => command === "npm" && args[0] === "install");
  assert.ok(delegated >= 0 && installed > delegated);
  assert.equal(setup.calls.filter(({ args }) => args[0] === "activity").length, 0);
});

for(const command of ["check", "doctor", "update"]) test(`${command} reads current 0.6 ownership and schema 2.3 without mutation`, async (context) => {
  const setup = await currentFixture(context);
  const files = [setup.config, setup.installed.manifest_path, setup.env.MEMOCAP_DB, path.join(setup.managedPath(), "SKILL.md")];
  const before = files.map((filename) => fs.readFileSync(filename, "utf8"));
  const report = await setup.setup([command, "--to", "0.7.0", ...(command === "update" ? ["--dry-run"] : [])]);
  assert.equal(report.error, null, JSON.stringify(report));
  assert.equal(report.backend.core_schema.observed, "2.3");
  assert.equal(report.backend.core_schema.status, "compatible");
  assert.equal(report.readiness, "incomplete");
  assert.deepEqual(files.map((filename) => fs.readFileSync(filename, "utf8")), before);
  assert.equal(setup.calls.some(({ command, args }) => command === "npx" || args[0] === "install" || args.includes("prepare")), false);
});
