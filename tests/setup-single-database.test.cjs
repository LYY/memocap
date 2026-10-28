"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture, failPolicyCopy } = require("./setup-fixtures.cjs");

const capabilities = ["receipt_v1", "recall_match", "multi_target", "inventory", "activity", "read_only_status", "single_database", "schema_2_compatible"];

function inspection(state, version) {
  return { core_status: state, schema_version: version,
    visible: state === "ready" ? { schema_version: version, placements: [], addressable_total: 0, effective_total: 0 } : null,
    activity_status: state, activity_error: null, capabilities };
}

function backend(context, observed) {
  const setup = fixture(context);
  setup.installCLI("0.1.0");
  const receipt = { format_version: 1, status: "ok", backend: "local", origin: "cli", inspection: observed };
  fs.writeFileSync(setup.cliScript, `#!${process.execPath}\nconst fs=require('node:fs');
const receipt=${JSON.stringify(receipt)};
if(process.argv.includes('--version')) console.log('memocap 0.1.0');
else if(process.argv.includes('prepare')) { fs.writeFileSync(process.env.MEMOCAP_DB,'prepared'); console.log(JSON.stringify({format_version:1,status:'ok'})); }
else { if(fs.existsSync(process.env.MEMOCAP_DB)) receipt.inspection=${JSON.stringify(inspection("ready", "2.0"))}; console.log(JSON.stringify(receipt)); }
`);
  setup.env.MEMOCAP_DB = path.join(setup.home, "main.db");
  return setup;
}

for (const [state, version] of [["not_initialized", null], ["upgrade_needed", "1.0"], ["ready", "2.0"], ["ready", "2.7"]]) {
  test(`check accepts ${state} ${version} without preparing main`, async (context) => {
    const setup = backend(context, inspection(state, version));
    const report = await setup.setup(["check", "--to", "0.1.0"]);
    assert.equal(report.error, null, JSON.stringify(report));
    assert.equal(report.backend.memory_status, state);
    assert.equal(report.backend.core_schema.observed, version);
    assert.equal(report.backend.core_schema.expected, "2.0");
    assert.equal(fs.existsSync(setup.env.MEMOCAP_DB), false);
    assert.equal(setup.calls.some(({ args }) => args.includes("prepare")), false);
  });
}

for (const state of ["not_initialized", "upgrade_needed"]) {
  test(`explicit install prepares ${state} main and verifies schema2`, async (context) => {
    const setup = backend(context, inspection(state, state === "upgrade_needed" ? "1.0" : null));
    const report = await setup.setup(["install", "--yes"]);
    assert.equal(report.exit_code, 0, JSON.stringify(report));
    assert.equal(report.readiness, "static_ready");
    assert.equal(report.backend.core_schema.observed, "2.0");
    assert.equal(report.backend.activity.status, "ready");
    assert.equal(fs.readFileSync(setup.env.MEMOCAP_DB, "utf8"), "prepared");
    assert.equal(setup.calls.filter(({ args }) => args.includes("prepare")).length, 1);
  });
}

test("dry-run reports upgrade needed without claiming readiness", async (context) => {
  const setup = backend(context, inspection("upgrade_needed", "1.0"));
  const report = await setup.setup(["update", "--to", "0.1.0", "--dry-run"]);
  assert.equal(report.error, null, JSON.stringify(report));
  assert.equal(report.readiness, "upgrade_needed");
  assert.equal(fs.existsSync(setup.env.MEMOCAP_DB), false);
});

test("doctor reports observed legacy upgrade even when component repair is needed", async (context) => {
  const setup = backend(context, inspection("upgrade_needed", "1.0"));
  const report = await setup.setup(["doctor"]);
  assert.equal(report.readiness, "upgrade_needed", JSON.stringify(report));
  assert.equal(report.exit_code, 1);
  assert.equal(fs.existsSync(setup.env.MEMOCAP_DB), false);
});

test("failed skill installation preserves legacy main until configuration prerequisites finish", async (context) => {
  const setup = backend(context, inspection("upgrade_needed", "1.0"));
  failPolicyCopy(context);
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.status, "partial", JSON.stringify(report));
  assert.equal(fs.existsSync(setup.env.MEMOCAP_DB), false);
  assert.equal(setup.calls.some(({ args }) => args.includes("prepare")), false);
});

test("lost process response after committed preparation is read back without replay on resume", async (context) => {
  const setup = backend(context, inspection("upgrade_needed", "1.0"));
  const run = setup.runtime.run;
  setup.runtime.run = async (command, args, options) => {
    const execution = await run(command, args, options);
    if (args.includes("prepare")) throw new Error("transport closed after commit");
    return execution;
  };
  const installed = await setup.setup(["install", "--yes"]);
  assert.equal(installed.exit_code, 0, JSON.stringify(installed));
  assert.equal(installed.steps.find(({ component }) => component === "backend").recovered_after_error, true);
  const resumed = await setup.setup(["install", "--yes"]);
  assert.equal(resumed.exit_code, 0, JSON.stringify(resumed));
  assert.equal(setup.calls.filter(({ args }) => args.includes("prepare")).length, 1);
});

test("remote legacy requires server administration without preparation", async (context) => {
  const setup = backend(context, inspection("upgrade_needed", "1.0"));
  setup.env.MEMOCAP_ADDR = "http://127.0.0.1:1";
  const script = fs.readFileSync(setup.cliScript, "utf8").replace('"backend":"local","origin":"cli"', '"backend":"remote","origin":"server"');
  fs.writeFileSync(setup.cliScript, script);
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.readiness, "upgrade_needed", JSON.stringify(report));
  assert.ok(report.warnings.some(({ code }) => code === "server_admin_required"));
  assert.equal(setup.calls.some(({ args }) => args.includes("prepare")), false);
});

const malformed = {
  major: { schema_version: "3.0" },
  incoherent: { visible: { schema_version: "2.7", placements: [], addressable_total: 0, effective_total: 0 } },
  negative_count: { visible: { schema_version: "2.0", placements: [], addressable_total: -1, effective_total: 0 } },
  missing_capabilities: { capabilities: capabilities.slice(0, -2) },
  malformed_capability: { capabilities: [...capabilities, { unexpected: true }] },
  false_ready: { activity_status: "upgrade_needed" },
};
for (const [name, patch] of Object.entries(malformed)) test(`malformed ${name} inspection is refused before writes`, async (context) => {
  const setup = backend(context, { ...inspection("ready", "2.0"), ...patch });
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.error?.code, "backend_incompatible", JSON.stringify(report));
  assert.equal(fs.existsSync(setup.env.MEMOCAP_DB), false);
});

test("POSIX generated shim resolves owned launcher and uses verified native cache", async (context) => {
  const setup = backend(context, inspection("ready", "2.0"));
  const { backendStatus } = await import("../scripts/setup/backend.mjs");
  const launcher = path.join(setup.installed, "bin/cli.cjs");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "throw new Error('launcher must not warm cache');\n");
  const shim = path.join(setup.root, "pnpm-memocap");
  fs.writeFileSync(shim, `#!/bin/sh\n# cmd-shim-target=${launcher}\nexit 99\n`, { mode: 0o755 });
  const report = { shared_cli: { version: "0.1.0", package_root: setup.installed, executable_path: shim, cache: { status: "verified", binary: setup.cliPath } } };
  const observed = await backendStatus({ report, runtime: setup.runtime });
  assert.equal(observed.core_schema.observed, "2.0");
  assert.equal(observed.executable_path, setup.cliPath);
});

test("released local 0.1 inspection permits planning its explicit binary upgrade", async (context) => {
  const observed = { ...inspection("ready", "1.0"), capabilities: capabilities.slice(0, -2) };
  const setup = backend(context, observed);
  const { backendStatus } = await import("../scripts/setup/backend.mjs");
  const metadata = JSON.parse(fs.readFileSync(path.join(setup.packageRoot, "package.json")));
  const next = metadata.version.split(".").map(Number); next[1] += 1;
  const report = { shared_cli: { version: metadata.version, executable_path: setup.cliPath, package_root: setup.installed } };
  const status = await backendStatus({ report, runtime: setup.runtime, target: next.join(".") });
  assert.equal(status.memory_status, "upgrade_needed");
  assert.equal(status.core_schema.observed, "1.0");
  assert.equal(status.inspection.visible, null);
  assert.equal(status.binary_contract, "released_schema_1");
});

test("a target binary cannot impersonate the released contract without single-database capabilities", async (context) => {
  const setup = backend(context, { ...inspection("ready", "1.0"), capabilities: capabilities.slice(0, -2) });
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.error?.code, "backend_incompatible");
  assert.equal(fs.existsSync(setup.env.MEMOCAP_DB), false);
});

for (const corruption of ["failed_status", "old_capabilities", "visible_version"]) test(`remote ${corruption} receipt is refused without server preparation`, async (context) => {
  const observed = inspection("ready", "2.0");
  if (corruption === "old_capabilities") observed.capabilities = capabilities.slice(0, -2);
  if (corruption === "visible_version") observed.visible.schema_version = "1.0";
  const setup = backend(context, observed);
  setup.env.MEMOCAP_ADDR = "http://127.0.0.1:1";
  let script = fs.readFileSync(setup.cliScript, "utf8").replace('"backend":"local","origin":"cli"', '"backend":"remote","origin":"server"');
  if (corruption === "failed_status") script = script.replace('"status":"ok"', '"status":"failed"');
  fs.writeFileSync(setup.cliScript, script);
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.error?.code, "backend_incompatible", JSON.stringify(report));
  assert.equal(fs.existsSync(setup.env.MEMOCAP_DB), false);
});
