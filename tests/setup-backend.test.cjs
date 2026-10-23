"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

function backendFixture(context, mode = "missing") {
  const setup = fixture(context);
  setup.env.MEMOCAP_DB = path.join(setup.home, "memory.db");
  setup.env.BACKEND_MODE = mode;
  setup.installCLI("0.1.0");
  const executable = path.join(setup.prefix, "bin/memocap");
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('memocap 0.1.0'); process.exit(0); }
const aux = process.env.MEMOCAP_DB + '.activity.sqlite';
const remote = Boolean(process.env.MEMOCAP_ADDR);
if (args.join(' ') === 'activity prepare --json') {
  if (remote) process.exit(8);
  if (process.env.PREPARE_MODE !== 'failed') fs.writeFileSync(aux, 'prepared');
  console.log(JSON.stringify({format_version:1,status:'ok',backend:'local'})); process.exit(process.env.PREPARE_MODE ? 1 : 0);
}
if (args[0] !== 'status' || !args.includes('--read-only') || !args.includes('--json')) process.exit(9);
const mode = process.env.BACKEND_MODE;
if (mode === 'malformed') { console.log(JSON.stringify({format_version:1,status:'ok',backend:'local',inspection:{core_status:'ready',schema_version:'1.0'}})); process.exit(0); }
if (mode === 'unknown' || mode === 'unsupported') {
  console.log(JSON.stringify({format_version:1,status:'failed',backend:remote?'remote':'local',error:{code:mode === 'unknown'?'operation_failed':'capability_unsupported',message:mode}})); process.exit(1);
}
console.log(JSON.stringify({format_version:1,status:'ok',backend:remote?'remote':'local',origin:remote?'server':'cli',inspection:{
core_status: mode === 'missing'?'not_initialized':'ready',schema_version:mode === 'missing'?null:'1.0',visible:mode === 'missing'?null:{addressable_total:3,effective_total:2},
activity_status:mode === 'degraded'?'degraded':fs.existsSync(aux)?'ready':'not_initialized',activity_error:mode === 'degraded'?'unsupported auxiliary schema':null,
capabilities:['receipt_v1','recall_match','multi_target','inventory','activity','read_only_status']}}));
`, { mode: 0o755 });
  return setup;
}

function tree(directory) {
  return fs.readdirSync(directory, { recursive: true }).sort().map((entry) => {
    const filename = path.join(directory, entry);
    return [entry, fs.statSync(filename).isFile() ? fs.readFileSync(filename).toString("base64") : null];
  });
}

test("check consumes missing-core inspection without creating storage", async (context) => {
  const setup = backendFixture(context);
  const before = tree(setup.home);
  const report = await setup.setup(["check", "--to", "0.1.0"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.backend.core_schema.status, "not_initialized");
  assert.equal(report.backend.inspection.visible, null);
  assert.deepEqual(tree(setup.home), before);
  assert.equal(report.runtime.status, "not_run");
});

test("check cannot claim installation ready when plugin and skill are absent", async (context) => {
  const setup = backendFixture(context);
  fs.writeFileSync(`${setup.env.MEMOCAP_DB}.activity.sqlite`, "prepared");
  const before = tree(setup.home);
  const report = await setup.setup(["check", "--to", "0.1.0"]);
  assert.equal(report.readiness, "incomplete");
  assert.equal(report.repair_required, true);
  assert.equal(report.backend.activity.status, "ready");
  assert.deepEqual(tree(setup.home), before);
});

test("install prepares auxiliary only once then reads status and reports no runtime memory yet", async (context) => {
  const setup = backendFixture(context);
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.readiness, "installation_ready");
  assert.equal(report.backend.activity.status, "ready");
  assert.equal(report.backend.memory_status, "not_initialized");
  assert.equal(fs.existsSync(setup.env.MEMOCAP_DB), false);
  assert.equal(setup.calls.filter(({ args }) => args.join(" ") === "activity prepare --json").length, 1);
  assert.equal(setup.calls.filter(({ command }) => command === setup.cliPath).at(-1).args[0], "status");
  const before = tree(setup.home);
  await setup.setup(["doctor"]);
  assert.deepEqual(tree(setup.home), before);
});

test("known core counts and degraded auxiliary are independent", async (context) => {
  const setup = backendFixture(context, "degraded");
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.backend.core_schema.status, "compatible");
  assert.equal(report.backend.inspection.visible.effective_total, 2);
  assert.equal(report.readiness, "activity_degraded");
  assert.equal(report.exit_code, 1);
  assert.ok(report.warnings.some(({ code }) => code === "activity_degraded"));
  assert.equal(setup.calls.some(({ args }) => args[0] === "activity"), false);
});

for (const mode of ["unknown", "unsupported"]) test(`${mode} backend stops install before mutation`, async (context) => {
  const setup = backendFixture(context, mode);
  if (mode === "unsupported") { setup.env.MEMOCAP_ADDR = "http://127.0.0.1:1"; setup.env.MEMOCAP_TOKEN = "never-print-this-token"; }
  const before = tree(setup.home);
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 1);
  assert.equal(report.backend.core_schema.status, "not_run");
  assert.equal(report.backend.status, "failed");
  assert.equal(report.steps.every(({ status }) => status === "not_run"), true);
  assert.deepEqual(tree(setup.home), before);
  assert.equal(JSON.stringify(report).includes("never-print-this-token"), false);
});

test("remote missing auxiliary requires server administrator without client preparation", async (context) => {
  const setup = backendFixture(context, "ready");
  setup.env.MEMOCAP_ADDR = "http://127.0.0.1:1";
  setup.env.MEMOCAP_TOKEN = "fixture-secret";
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.backend.remote_capabilities.status, "compatible");
  assert.equal(report.backend.activity.status, "not_initialized");
  assert.equal(report.readiness, "activity_not_initialized");
  assert.ok(report.warnings.some(({ code }) => code === "server_admin_required"));
  assert.equal(setup.calls.some(({ args }) => args[0] === "activity"), false);
});

test("dry run observes ready core and auxiliary without preparation", async (context) => {
  const setup = backendFixture(context, "ready");
  fs.writeFileSync(setup.env.MEMOCAP_DB, "fixture core bytes");
  fs.writeFileSync(`${setup.env.MEMOCAP_DB}.activity.sqlite`, "prepared");
  const before = tree(setup.home);
  const report = await setup.setup(["update", "--to", "0.1.0", "--dry-run"]);
  assert.equal(report.backend.core_schema.status, "compatible");
  assert.equal(report.backend.activity.status, "ready");
  assert.equal(report.backend.inspection.visible.addressable_total, 3);
  assert.deepEqual(tree(setup.home), before);
  assert.equal(setup.calls.some(({ args }) => args[0] === "activity"), false);
});

test("doctor reports installation ready with missing core and never mutates prepared auxiliary", async (context) => {
  const setup = backendFixture(context);
  await setup.setup(["install", "--yes"]);
  const cache = path.join(setup.home, "Library/Caches/memocap/0.1.0");
  fs.mkdirSync(cache, { recursive: true });
  const name = "memocap-aarch64-apple-darwin";
  fs.writeFileSync(path.join(cache, name), "fixture cached binary");
  fs.writeFileSync(path.join(cache, `${name}.sha256`), `${crypto.createHash("sha256").update("fixture cached binary").digest("hex")}  ${name}\n`);
  const before = tree(setup.home);
  setup.calls.length = 0;
  const report = await setup.setup(["doctor"]);
  assert.equal(report.status, "installation_ready", JSON.stringify(report));
  assert.equal(report.exit_code, 0);
  assert.equal(report.runtime.status, "not_run");
  assert.equal(report.restart_required, false);
  assert.deepEqual(tree(setup.home), before);
  assert.equal(setup.calls.some(({ args }) => args[0] === "activity"), false);
});

test("malformed inspection cannot masquerade as compatible core", async (context) => {
  const setup = backendFixture(context, "malformed");
  const report = await setup.setup(["check", "--to", "0.1.0"]);
  assert.equal(report.exit_code, 1);
  assert.equal(report.error.code, "backend_incompatible");
});

for (const mode of ["lost", "failed"]) test(`prepare ${mode} response is reconciled by readback before retry`, async (context) => {
  const setup = backendFixture(context);
  setup.env.PREPARE_MODE = mode;
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.exit_code, mode === "lost" ? 0 : 1, JSON.stringify(report));
  const checkpoint = report.steps.find(({ component }) => component === "backend");
  assert.equal(checkpoint.status, mode === "lost" ? "changed" : "outcome_unknown");
  assert.equal(setup.calls.filter(({ args }) => args[0] === "activity").length, 1);
  assert.equal(setup.calls.filter(({ command }) => command === setup.cliPath).at(-1).args[0], "status");
});

test("readonly inspection refuses a PATH copy instead of warming an official launcher cache", async (context) => {
  const setup = backendFixture(context);
  fs.mkdirSync(path.join(setup.installed, "bin"));
  fs.writeFileSync(path.join(setup.installed, "bin/cli.cjs"), "official launcher fixture");
  const report = await setup.setup(["check", "--to", "0.1.0"]);
  assert.equal(report.exit_code, 1);
  assert.equal(report.error.code, "cli_path_mismatch");
  assert.equal(setup.calls.some(({ command }) => path.isAbsolute(command)), false);
});

test("readonly inspection refuses a Windows shim outside the installed package", async (context) => {
  const setup = backendFixture(context);
  const { backendStatus } = await import("../scripts/setup/backend.mjs");
  fs.mkdirSync(path.join(setup.installed, "bin"));
  fs.writeFileSync(path.join(setup.installed, "bin/cli.cjs"), "official launcher fixture");
  const shim = path.join(setup.prefix, "bin/memocap.cmd");
  fs.writeFileSync(shim, "@echo off\r\n");
  const report = { shared_cli: { package_root: setup.installed, executable_path: shim, cache: { status: "missing" } } };
  await assert.rejects(backendStatus({ report, runtime: setup.runtime }), { code: "cli_path_mismatch" });
  assert.equal(setup.calls.length, 0);
});
