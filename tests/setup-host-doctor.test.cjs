"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");
const { snapshot } = require("./packaged-runtime.cjs");

function fixtureUnderHostAncestor(context) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-doctor-"));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const temporaryDirectory = context.mock.method(os, "tmpdir", () => parent);
  try {
    const setup = fixture(context);
    setup.state.afterCommand = () => assertHostNotStarted(setup);
    return setup;
  }
  finally { temporaryDirectory.mock.restore(); }
}

function assertHostNotStarted(setup) {
  const host = path.join(setup.root, "host/bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
  assert.equal(setup.calls.some(({ command }) => command === host), false);
}

for (const version of ["1.19.3", "1.19.5", "1.20.0"]) test(`doctor accepts complete installation on host ${version} without starting host`, async (context) => {
  const setup = fixtureUnderHostAncestor(context);
  const installed = await setup.setup(["install", "--yes"]);
  assert.equal(installed.exit_code, 0, JSON.stringify(installed));
  fs.writeFileSync(path.join(setup.root, "host/package.json"), JSON.stringify({ name: "opencode-ai", version }));
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
  assertHostNotStarted(setup);
  assert.deepEqual(snapshot([setup.root]), before);
});

for (const version of ["1.19.3", "1.19.5"]) test(`no-host guard rejects attempted fixture host dispatch on ${version} before execution`, async (context) => {
  const setup = fixtureUnderHostAncestor(context);
  fs.writeFileSync(path.join(setup.root, "host/package.json"), JSON.stringify({ name: "opencode-ai", version }));
  const host = path.join(setup.root, "host/bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
  setup.state.fail = () => true;
  const before = snapshot([setup.root]);

  await assert.rejects(setup.runtime.run(host, ["--version"]), { code: "ERR_ASSERTION", actual: true, expected: false });

  assert.deepEqual(setup.calls, [{ command: host, args: ["--version"], cwd: undefined }]);
  assert.deepEqual(snapshot([setup.root]), before);
});

for (const version of ["0.19.4", "2.0.0", "1.20"]) test(`install refuses unsupported host ${version} before mutation`, async (context) => {
  const setup = fixture(context);
  fs.writeFileSync(path.join(setup.root, "host/package.json"), JSON.stringify({ name: "opencode-ai", version }));
  const before = snapshot([setup.root]);

  const report = await setup.setup(["install", "--yes"]);

  assert.equal(report.error.code, "unsupported_host");
  assert.equal(report.exit_code, 1);
  assert.deepEqual(setup.calls, []);
  assert.deepEqual(snapshot([setup.root]), before);
});
