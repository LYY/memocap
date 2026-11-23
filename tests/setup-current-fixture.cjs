"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixture } = require("./setup-fixtures.cjs");
const { version: currentVersion } = require("../package.json");

function databaseCLI(setup, version) {
  setup.installCLI(version);
  fs.writeFileSync(setup.cliScript, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args[0] === '--version') { console.log('memocap ${version}'); process.exit(0); }
const database = process.env.MEMOCAP_DB;
const stored = JSON.parse(fs.readFileSync(database));
if(args.join(' ') === 'activity prepare --json') {
  process.exit(9);
}
if(args.join(' ') !== 'status --read-only --json') process.exit(9);
const upgrade = stored.schema === '2.2';
console.log(JSON.stringify({format_version:1,status:'ok',backend:'local',origin:'cli',inspection:{
  core_status:upgrade?'upgrade_needed':'ready',schema_version:stored.schema,
  visible:upgrade?null:{schema_version:stored.schema,placements:[],addressable_total:1,effective_total:1},
  activity_status:upgrade?'upgrade_needed':'ready',activity_error:null,
  capabilities:['receipt_v1','recall_match','multi_target','inventory','activity','read_only_status','single_database','schema_2_compatible']}}));
`);
}

async function currentFixture(context) {
  const setup = fixture(context);
  fs.writeFileSync(path.join(setup.packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.6.0" }));
  setup.state.stable = "0.6.0";
  fs.mkdirSync(path.dirname(setup.config), { recursive: true });
  fs.writeFileSync(setup.config, JSON.stringify({ model: "fixture/model", permission: { custom_tool: { "private/*": "deny" } }, custom: { retained: true } }));
  const installed = await setup.setup(["install", "--yes"]);
  assert.equal(installed.exit_code, 0, JSON.stringify(installed));
  setup.env.MEMOCAP_DB = path.join(setup.home, "current.db");
  fs.writeFileSync(setup.env.MEMOCAP_DB, JSON.stringify({ schema: "2.3", memories: [{ id: 17, placement: "universal", content: "preserved memory", kind: "decision", tags: "fixture", topic: "upgrade", created_at: "2026-10-28", updated_at: "2026-10-29", organized_at: "2026-10-30" }], activity: [{ sequence: 5, phase: "capture_review", model_calls: 3 }], domains: ["fixture/domain"], attachments: ["fixture/domain"], provenance: [{ memory_id: 17, origin: "fixture" }], ledger: [{ operation_id: "fixture-copy", memory_id: 17 }], repository_metadata: ["preserved hint"], repository_identity: { display_name: "fixture" }, repository_locations: ["/fixture/checkout"] }));
  databaseCLI(setup, "0.6.0");
  const manifest = JSON.parse(fs.readFileSync(installed.manifest_path));
  const record = manifest.installs[installed.scopes[0].id];
  record.migration = { status: "completed", from: "native" };
  record.adoption = { skill: { source: "LYY/memocap", ref: "v0.2.1", fingerprint: "sanitized-inert-proof" } };
  record.steps.legacy_cleanup = { status: "completed", retained: [] };
  fs.writeFileSync(installed.manifest_path, JSON.stringify(manifest));
  const targetRoot = path.join(setup.root, "target-worker");
  fs.cpSync(setup.packageRoot, targetRoot, { recursive: true });
  fs.writeFileSync(path.join(targetRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: currentVersion }));
  fs.appendFileSync(path.join(targetRoot, "skills/memocap/SKILL.md"), "\ntarget fixture payload\n");
  const run = setup.runtime.run;
  setup.runtime.run = async (command, args, options) => {
    if(command === "npx" && args.includes(`@lyy-gh/memocap@${currentVersion}`)) {
      setup.calls.push({ command, args: [...args] });
      const { runSetup } = await import("../scripts/setup/core.mjs");
      const report = await runSetup(args.slice(args.indexOf("memocap-setup") + 1), { ...setup.runtime, packageRoot: targetRoot });
      return { code: report.exit_code, stdout: JSON.stringify(report), stderr: "" };
    }
    const execution = await run(command, args, options);
    if(command === "npm" && args[0] === "install") {
      databaseCLI(setup, currentVersion);
      fs.cpSync(path.join(targetRoot, "skills"), path.join(setup.installed, "skills"), { recursive: true });
    }
    return execution;
  };
  setup.calls.length = 0;
  return { ...setup, installed, targetRoot };
}

module.exports = { currentFixture };
