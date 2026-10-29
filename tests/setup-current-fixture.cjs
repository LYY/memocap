"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture } = require("./setup-fixtures.cjs");

function databaseCLI(setup, version) {
  setup.installCLI(version);
  fs.writeFileSync(setup.cliScript, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args[0] === '--version') { console.log('memocap ${version}'); process.exit(0); }
const database = process.env.MEMOCAP_DB;
const stored = JSON.parse(fs.readFileSync(database));
if(args.join(' ') === 'activity prepare --json') {
  stored.schema = '2.2'; fs.writeFileSync(database, JSON.stringify(stored));
  console.log(JSON.stringify({format_version:1,status:'ok',backend:'local'})); process.exit(0);
}
if(args.join(' ') !== 'status --read-only --json') process.exit(9);
const upgrade = '${version}' === '0.5.0' && stored.schema === '2.1';
console.log(JSON.stringify({format_version:1,status:'ok',backend:'local',origin:'cli',inspection:{
  core_status:upgrade?'upgrade_needed':'ready',schema_version:stored.schema,
  visible:upgrade?null:{schema_version:stored.schema,placements:[],addressable_total:1,effective_total:1},
  activity_status:upgrade?'upgrade_needed':'ready',activity_error:null,
  capabilities:['receipt_v1','recall_match','multi_target','inventory','activity','read_only_status','single_database','schema_2_compatible']}}));
`);
}

async function currentFixture(context) {
  const setup = fixture(context);
  fs.writeFileSync(path.join(setup.packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.4.0" }));
  setup.state.stable = "0.4.0";
  const installed = await setup.setup(["install", "--yes"]);
  assert.equal(installed.exit_code, 0, JSON.stringify(installed));
  setup.env.MEMOCAP_DB = path.join(setup.home, "current.db");
  fs.writeFileSync(setup.env.MEMOCAP_DB, JSON.stringify({ schema: "2.1", memories: [{ id: "sanitized-memory", content: "preserved memory", organized_at: "2026-10-28" }], activity: ["preserved activity"], repository_metadata: ["preserved hint"] }));
  databaseCLI(setup, "0.4.0");
  const manifest = JSON.parse(fs.readFileSync(installed.manifest_path));
  const record = manifest.installs[installed.scopes[0].id];
  record.migration = { status: "completed", from: "native" };
  record.adoption = { skill: { source: "LYY/memocap", ref: "v0.2.1", fingerprint: "sanitized-inert-proof" } };
  record.steps.legacy_cleanup = { status: "completed", retained: [] };
  fs.writeFileSync(installed.manifest_path, JSON.stringify(manifest));
  const targetRoot = path.join(setup.root, "target-worker");
  fs.cpSync(setup.packageRoot, targetRoot, { recursive: true });
  fs.writeFileSync(path.join(targetRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.5.0" }));
  const run = setup.runtime.run;
  setup.runtime.run = async (command, args, options) => {
    if(command === "npx" && args.includes("@lyy-gh/memocap@0.5.0")) {
      setup.calls.push({ command, args: [...args] });
      const { runSetup } = await import("../scripts/setup/core.mjs");
      const report = await runSetup(args.slice(args.indexOf("memocap-setup") + 1), { ...setup.runtime, packageRoot: targetRoot });
      return { code: report.exit_code, stdout: JSON.stringify(report), stderr: "" };
    }
    const execution = await run(command, args, options);
    if(command === "npm" && args[0] === "install") databaseCLI(setup, "0.5.0");
    return execution;
  };
  setup.calls.length = 0;
  return { ...setup, installed, targetRoot };
}

module.exports = { currentFixture };
