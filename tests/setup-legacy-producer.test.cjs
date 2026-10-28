"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

function legacy(context) {
  const setup = fixture(context);
  setup.installCLI("0.0.10");
  fs.writeFileSync(setup.cliScript, `#!${process.execPath}
if(process.argv.includes('--version')) console.log('memocap 0.0.10');
else { console.error('unsupported inspection interface'); process.exit(2); }
`);
  return setup;
}

for (const command of ["check", "update"]) test(`${command} rejects unavailable obsolete producer inspection without mutation`, async (context) => {
  const setup = legacy(context);
  const report = await setup.setup([command, "--to", "0.1.0", ...(command === "update" ? ["--dry-run"] : [])]);
  assert.equal(report.error?.code, "backend_receipt_invalid");
  assert.equal(setup.calls.some(({ args }) => args[0] === "install" || args.includes("prepare")), false);
  assert.equal(fs.existsSync(path.join(setup.home, ".memocap")), false);
});

test("authorized update refuses an obsolete producer before installing its target", async (context) => {
  const setup = legacy(context);
  const report = await setup.setup(["update", "--to", "0.1.0", "--yes"]);
  assert.equal(report.error?.code, "backend_receipt_invalid");
  assert.equal(setup.calls.some(({ args }) => args[0] === "install" || args.includes("prepare")), false);
});

test("local 0.0.10 cannot defer a mismatched executable identity", async (context) => {
  const setup = legacy(context);
  fs.writeFileSync(setup.cliScript, "console.log('memocap 9.0.0');\n");
  const report = await setup.setup(["update", "--dry-run"]);
  assert.equal(report.error?.code, "cli_version_mismatch");
});

test("remote 0.0.10 cannot defer unavailable server inspection", async (context) => {
  const setup = legacy(context);
  setup.env.MEMOCAP_ADDR = "http://127.0.0.1:1";
  const report = await setup.setup(["update", "--dry-run"]);
  assert.notEqual(report.error, null);
  assert.equal(setup.calls.some(({ args }) => args.includes("prepare")), false);
});
