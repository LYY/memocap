"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { lifecycleFixture, snapshot, write } = require("./setup-package-lifecycle-fixture.cjs");

test("published 0.5.0 managed installation preserves data when upgraded to local 0.6.0", {
  skip: process.env.MEMOCAP_V050_UPGRADE_E2E !== "1",
  timeout: 900000,
}, async (context) => {
  const { runScenario } = require("./setup-v050-upgrade/scenario.cjs");
  const workspace = path.resolve(__dirname, "..");
  const filename = path.resolve(process.env.MEMOCAP_V050_UPGRADE_EVIDENCE ||
    path.join(os.tmpdir(), `memocap-v050-upgrade-${crypto.randomUUID()}.json`));
  const evidence = { format_version: 1, started_at: new Date().toISOString(), platform: process.platform,
    arch: process.arch, node: process.version, status: "running", commands: [], outcomes: [], assertions: [],
    paid_provider_calls: 0, user_data_used: false, runtime_host_qa: "not_run", cleanup: {} };
  const fixture = lifecycleFixture(workspace, evidence);
  fixture.env.npm_config_cache = path.join(fixture.root, "npm-cache");
  context.after(async () => {
    try { evidence.cleanup = await fixture.cleanup(); }
    catch (error) {
      evidence.status = "failed";
      evidence.cleanup.failure = { message: error.message, stack: error.stack };
      throw error;
    } finally {
      evidence.finished_at = new Date().toISOString();
      write(filename, `${JSON.stringify(evidence, null, 2)}\n`);
      assert.equal(JSON.parse(fs.readFileSync(filename, "utf8")).status, evidence.status);
      context.diagnostic(`upgrade evidence: ${filename}`);
    }
  });
  try {
    assert.ok(!filename.startsWith(`${path.resolve(fixture.root)}${path.sep}`), "evidence must survive sandbox cleanup");
    await runScenario(fixture, evidence);
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.failure = { message: error.message, stack: error.stack };
    try {
      evidence.failure_files = snapshot([fixture.env.MEMOCAP_DATA_DIR, fixture.env.XDG_CONFIG_HOME, fixture.env.XDG_STATE_HOME]);
      if (fs.existsSync(fixture.env.MEMOCAP_DB)) {
        evidence.failure_database = require("./setup-v050-upgrade/snapshots.cjs").databaseSnapshot(fixture.env.MEMOCAP_DB);
      }
    } catch (inspectionError) {
      evidence.failure_inspection = { message: inspectionError.message, stack: inspectionError.stack };
    }
    throw error;
  }
});
