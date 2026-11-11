"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");
const { snapshot } = require("./packaged-runtime.cjs");

for (const version of ["1.19.3", "1.19.5"]) test(`doctor accepts complete installation on tested host ${version} without starting host`, async (context) => {
  const setup = fixture(context);
  fs.writeFileSync(path.join(setup.root, "host/package.json"), JSON.stringify({ name: "opencode-ai", version }));
  const installed = await setup.setup(["install", "--yes"]);
  assert.equal(installed.exit_code, 0, JSON.stringify(installed));
  const binary = setup.cacheBinary("0.1.0");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "fixture cached binary");
  fs.writeFileSync(`${binary}.sha256`, `${crypto.createHash("sha256").update("fixture cached binary").digest("hex")}  ${path.basename(binary)}\n`);
  const before = snapshot([setup.root]);
  setup.calls.length = 0;

  const report = await setup.setup(["doctor"]);

  assert.equal(report.status, "static_ready", JSON.stringify(report));
  assert.equal(report.exit_code, 0);
  assert.equal(report.prerequisites.opencode, version);
  assert.equal(report.runtime.status, "not_run");
  assert.equal(setup.calls.some(({ command }) => command.includes("opencode")), false);
  assert.deepEqual(snapshot([setup.root]), before);
});

for (const version of ["1.19.4", "1.19.6", "1.20.0"]) test(`install refuses untested host ${version} before mutation`, async (context) => {
  const setup = fixture(context);
  fs.writeFileSync(path.join(setup.root, "host/package.json"), JSON.stringify({ name: "opencode-ai", version }));
  const before = snapshot([setup.root]);

  const report = await setup.setup(["install", "--yes"]);

  assert.equal(report.error.code, "unsupported_host");
  assert.equal(report.exit_code, 1);
  assert.deepEqual(setup.calls, []);
  assert.deepEqual(snapshot([setup.root]), before);
});
