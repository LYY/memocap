"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

const capabilities = ["receipt_v1", "recall_match", "multi_target", "inventory", "activity", "read_only_status", "single_database", "schema_2_compatible"];

function ready(schema) {
  return { core_status: "ready", schema_version: schema,
    visible: { schema_version: schema, placements: [], addressable_total: 1, effective_total: 1 },
    activity_status: "ready", activity_error: null, capabilities };
}

function producer(context, version, inspection) {
  const setup = fixture(context);
  setup.installCLI(version);
  const run = setup.runtime.run;
  setup.runtime.run = async (command, args, options) => {
    if (args[0] !== "status") return run(command, args, options);
    setup.calls.push({ command, args: [...args] });
    const remote = Boolean(setup.env.MEMOCAP_ADDR);
    return { code: 0, stderr: "", stdout: JSON.stringify({ format_version: 1, status: "ok",
      backend: remote ? "remote" : "local", origin: remote ? "server" : "cli", inspection }) };
  };
  return { runtime: setup.runtime, target: "0.6.0", manifest: {},
    report: { shared_cli: { version, package_root: setup.installed, executable_path: setup.cliPath } }, setup };
}

test("exact installed 0.5 ready 2.2 is preflight only, never target readiness", async (context) => {
  const current = producer(context, "0.5.0", ready("2.2"));
  const { backendStatus, backendReadiness } = await import("../scripts/setup/backend.mjs");
  const observed = await backendStatus(current);
  assert.equal(observed.core_schema.observed, "2.2");
  assert.equal(observed.core_schema.expected, "2.3");
  assert.equal(backendReadiness(current.report), "upgrade_needed");
  assert.equal(current.setup.calls.some(({ args }) => args.includes("prepare")), false);
});

test("current 0.6 ready 2.3 and activity ready satisfies backend readiness", async (context) => {
  const current = producer(context, "0.6.0", ready("2.3"));
  const { backendStatus, backendReadiness } = await import("../scripts/setup/backend.mjs");
  await backendStatus(current);
  assert.equal(backendReadiness(current.report), "static_ready");
});

for (const [name, version, schema, target, remote] of [
  ["obsolete 0.4 producer", "0.4.0", "2.1", "0.6.0", false],
  ["retired 0.4 to 0.5 shim", "0.4.0", "2.1", "0.5.0", false],
  ["current producer false ready", "0.6.0", "2.2", "0.6.0", false],
  ["same-version prior producer", "0.5.0", "2.2", "0.5.0", false],
  ["future target", "0.5.0", "2.2", "0.7.0", false],
  ["remote prior producer", "0.5.0", "2.2", "0.6.0", true],
  ["future schema", "0.5.0", "2.4", "0.6.0", false],
]) test(`${name} is refused before preparation`, async (context) => {
  const current = producer(context, version, ready(schema));
  if (remote) current.setup.env.MEMOCAP_ADDR = "http://127.0.0.1:1";
  current.target = target;
  const { backendStatus } = await import("../scripts/setup/backend.mjs");
  await assert.rejects(backendStatus(current), { code: "backend_incompatible" });
  assert.equal(current.setup.calls.some(({ args }) => args.includes("prepare")), false);
});

for (const inspection of [
  { ...ready("2.2"), visible: null },
  { ...ready("2.2"), visible: { schema_version: "2.3", placements: [], addressable_total: 1, effective_total: 1 } },
  { ...ready("2.2"), activity_status: "upgrade_needed" },
  { ...ready("2.2"), capabilities: [] },
]) test("prior producer cannot relax malformed receipt validation", async (context) => {
  const current = producer(context, "0.5.0", inspection);
  const { backendStatus } = await import("../scripts/setup/backend.mjs");
  await assert.rejects(backendStatus(current), { code: "backend_incompatible" });
});

test("preparation acknowledgement cannot replace independent target schema readback", async (context) => {
  const inspection = { core_status: "upgrade_needed", schema_version: "2.2", visible: null,
    activity_status: "upgrade_needed", activity_error: null, capabilities };
  const current = producer(context, "0.6.0", inspection);
  const run = current.runtime.run;
  current.runtime.run = async (command, args, options) => {
    if (args.includes("prepare")) {
      current.setup.calls.push({ command, args: [...args] });
      Object.assign(inspection, ready("2.2"));
      return { code: 0, stdout: '{"format_version":1,"status":"ok"}', stderr: "" };
    }
    return run(command, args, options);
  };
  const { prepareBackend } = await import("../scripts/setup/backend.mjs");
  await assert.rejects(prepareBackend(current), { code: "activity_outcome_unknown" });
  assert.equal(current.setup.calls.filter(({ args }) => args.includes("prepare")).length, 1);
  assert.equal(current.setup.calls.at(-1).args[0], "status");
});
