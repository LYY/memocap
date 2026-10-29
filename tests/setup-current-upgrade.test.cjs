"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { currentFixture } = require("./setup-current-fixture.cjs");

test("current managed 0.4 ownership with inert history upgrades via exact 0.5 worker and preserves main content", async (context) => {
  const setup = await currentFixture(context);
  const before = JSON.parse(fs.readFileSync(setup.env.MEMOCAP_DB));
  const report = await setup.setup(["update", "--to", "0.5.0", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.delegated_worker, true);
  assert.equal(report.bootstrap_runner_version, "0.4.0");
  assert.equal(report.runner_version, "0.5.0");
  assert.equal(report.backend.core_schema.observed, "2.2");
  assert.equal(report.readiness, "static_ready");
  assert.deepEqual(JSON.parse(fs.readFileSync(setup.env.MEMOCAP_DB)), { ...before, schema: "2.2" });
  assert.equal(JSON.parse(fs.readFileSync(report.manifest_path)).format_version, 2);
  assert.equal(JSON.parse(fs.readFileSync(setup.config)).plugin[0][0], "@lyy-gh/memocap@0.5.0");
  const delegated = setup.calls.findIndex(({ command }) => command === "npx");
  const installed = setup.calls.findIndex(({ command, args }) => command === "npm" && args[0] === "install");
  const prepared = setup.calls.findIndex(({ args }) => args[0] === "activity");
  assert.ok(delegated >= 0 && installed > delegated && prepared > installed);
  assert.equal(setup.calls.filter(({ args }) => args[0] === "activity").length, 1);
});

for(const command of ["doctor", "update"]) test(`${command} reads current 0.4 ownership and schema 2.1 without mutation`, async (context) => {
  const setup = await currentFixture(context);
  const files = [setup.config, setup.installed.manifest_path, setup.env.MEMOCAP_DB, path.join(setup.managedPath(), "SKILL.md")];
  const before = files.map((filename) => fs.readFileSync(filename, "utf8"));
  const report = await setup.setup([command, "--to", "0.5.0", ...(command === "update" ? ["--dry-run"] : [])]);
  assert.equal(report.error, null, JSON.stringify(report));
  assert.equal(report.backend.core_schema.observed, "2.1");
  assert.deepEqual(files.map((filename) => fs.readFileSync(filename, "utf8")), before);
  assert.equal(setup.calls.some(({ command, args }) => command === "npx" || args[0] === "install" || args.includes("prepare")), false);
});
