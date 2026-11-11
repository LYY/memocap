"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { preparePrior } = require("./prior.cjs");
const { databaseSnapshot, managedSnapshot, assertRetained } = require("./snapshots.cjs");
const { digest, snapshot, write } = require("../packaged-runtime.cjs");

async function runScenario(fixture, evidence) {
  const { command, env, installedRoot, project } = fixture;
  assert.equal(fixture.version, "0.6.0");
  const prepared = await fixture.prepare();
  env.npm_config_ignore_scripts = "true";
  await preparePrior(fixture, evidence);
  const config = path.join(env.XDG_CONFIG_HOME, "opencode/opencode.json");
  const sentinel = { model: "unused/synthetic-upgrade-model", share: "disabled", skills: { paths: [] }, permission: { edit: "ask" } };
  write(config, `// synthetic operator sentinel: preserve this comment\n${JSON.stringify({ ...sentinel, plugin: [] }, null, 2)}\n`);
  const oldSetup = path.join(installedRoot, "scripts/setup.mjs");
  const newSetup = path.join(prepared.runnerRoot, "scripts/setup.mjs");
  evidence.target_setup_help = (await command(process.execPath, [newSetup, "--help"])).stdout;
  const setup = async (entry, args) => {
    const result = await command(process.execPath, [entry, ...args, "--global", "--json"], { allowFailure: true });
    const outcome = { entry, args: [...args, "--global", "--json"], ...result };
    evidence.outcomes.push(outcome);
    const report = JSON.parse(result.stdout);
    outcome.report = report;
    assert.equal(result.code, report.exit_code);
    assert.equal(report.exit_code, 0, JSON.stringify(report));
    assert.equal(report.error, null);
    return report;
  };
  const cli = async (args) => {
    const result = await command("memocap", [...args, "--repo", project, "--json"], { allowFailure: true });
    const outcome = { cli: args, ...result };
    evidence.outcomes.push(outcome);
    const receipt = JSON.parse(result.stdout);
    outcome.receipt = receipt;
    assert.equal(result.code, 0, JSON.stringify(receipt));
    return receipt;
  };
  const installed = await setup(oldSetup, ["install", "--to", "0.5.0", "--yes"]);
  assert.equal(installed.shared_cli.executable_version, "0.5.0");
  assert.equal(installed.backend.core_schema.observed, "2.2");
  assert.equal(installed.backend.activity.status, "ready");
  await cli(["scope", "domain", "create", "upgrade-e2e"]);
  await cli(["scope", "domain", "attach", "upgrade-e2e"]);
  const remembered = await cli(["remember", "Synthetic repository upgrade record", "--tags", "upgrade,repository", "--topic", "upgrade.repository", "--force"]);
  await cli(["remember", "Synthetic domain upgrade record", "--domain", "upgrade-e2e", "--tags", "domain", "--topic", "upgrade.domain", "--force"]);
  await cli(["remember", "Synthetic universal upgrade record", "--universal", "--tags", "universal", "--topic", "upgrade.universal", "--force"]);
  const operationId = "00000000-0000-4000-8000-000000000506";
  await cli(["scope", "copy", "--id", String(remembered.returned_ids[0]), "--from", remembered.results[0].memory.placement,
    "--to", "universal", "--operation-id", operationId, "--note", "synthetic prior copy provenance"]);
  await cli(["recall", "Synthetic", "--match", "all"]);
  const oldStatus = await cli(["status", "--read-only"]);
  assert.equal(oldStatus.inspection.core_status, "ready");
  assert.equal(oldStatus.inspection.schema_version, "2.2");
  const before = databaseSnapshot(env.MEMOCAP_DB);
  const ownership = await managedSnapshot(fixture, config);
  evidence.before = { database: before, ownership, producer: oldStatus };
  assert.equal(before.schema_version, "2.2");
  assert.equal(before.tables.memories.length, 4);
  for (const name of ["domains", "repository_domain_attachments", "repository_identities", "repository_locations", "memory_provenance", "operation_ledger"]) {
    assert.ok(before.tables[name].length > 0, `prior CLI must populate ${name}`);
  }
  assert.equal(before.tables.operation_ledger[0].operation_id, operationId);
  assert.ok(before.tables.activity_events.some((row) => row.phase === "recall"));
  assert.ok(before.tables.activity_events.some((row) => row.phase === "write"));
  assert.equal(ownership.manifest.cli.version, "0.5.0");
  assert.equal(Object.values(ownership.manifest.installs)[0].skill.version, "0.5.0");
  assert.deepEqual(ownership.config.permission, sentinel.permission);
  const persistent = [config, installed.manifest_path, ownership.policy.directory, fixture.prefix, env.MEMOCAP_DB];
  const bytesBefore = snapshot(persistent);
  evidence.preflight = [];
  for (const args of [["check", "--to", "0.6.0"], ["update", "--to", "0.6.0", "--dry-run"]]) {
    const report = await setup(newSetup, args);
    evidence.preflight.push(report);
    assert.equal(report.runner_version, "0.6.0");
    assert.equal(report.shared_cli.version, "0.5.0");
    assert.equal(report.shared_cli.executable_version, "0.5.0");
    assert.equal(report.backend.core_schema.observed, "2.2");
    assert.equal(report.backend.core_schema.status, "upgrade_needed");
    assert.equal(report.readiness, "upgrade_needed");
    assert.deepEqual(databaseSnapshot(env.MEMOCAP_DB), before);
    assert.deepEqual(await managedSnapshot(fixture, config), ownership);
    assert.deepEqual(snapshot(persistent), bytesBefore, "check/dry-run must preserve database and all installed bytes");
  }
  evidence.assertions.push("real 0.5 producer/schema 2.2 accepted only as immutable preflight");
  const upgraded = await setup(newSetup, ["update", "--to", "0.6.0", "--yes"]);
  assert.equal(upgraded.runner_version, "0.6.0");
  assert.equal(upgraded.resolved_version, "0.6.0");
  assert.equal(upgraded.shared_cli.version, "0.6.0");
  assert.equal(upgraded.shared_cli.executable_version, "0.6.0");
  assert.equal(upgraded.backend.core_schema.observed, "2.3");
  assert.equal(upgraded.backend.activity.status, "ready");
  assert.equal(upgraded.readiness, "static_ready");
  assert.equal(upgraded.runtime.status, "not_run");
  assert.equal((await command("memocap", ["--version"])).stdout.trim(), "memocap 0.6.0");
  const status = await cli(["status", "--read-only"]);
  assert.equal(status.inspection.core_status, "ready");
  assert.equal(status.inspection.schema_version, "2.3");
  assert.equal(status.inspection.activity_status, "ready");
  const after = databaseSnapshot(env.MEMOCAP_DB);
  const newOwnership = await managedSnapshot(fixture, config);
  evidence.after = { database: after, ownership: newOwnership, producer: status };
  assert.equal(after.schema_version, "2.3");
  assertRetained(before, after);
  const owner = Object.values(newOwnership.manifest.installs)[0];
  assert.equal(newOwnership.manifest.cli.version, "0.6.0");
  assert.equal(owner.version, "0.6.0");
  assert.equal(owner.skill.version, "0.6.0");
  for (const file of evidence.pack.files) {
    assert.equal(digest(fs.readFileSync(path.join(installedRoot, file.path))), file.sha256,
      `installed package file must match the verified target tarball: ${file.path}`);
  }
  assert.notEqual(newOwnership.policy.digest, ownership.policy.digest);
  assert.notEqual(newOwnership.policy.directory, ownership.policy.directory);
  assert.ok(newOwnership.policy.directory.includes(`0.6.0-${newOwnership.policy.digest}`));
  const readGrants = { memocap_recall: { library: "allow" }, memocap_read: { library: "allow" } };
  assert.deepEqual(newOwnership.config, { ...sentinel,
    skills: { ...sentinel.skills, paths: [newOwnership.policy.directory] }, plugin: newOwnership.config.plugin,
    permission: { ...sentinel.permission, ...readGrants } });
  assert.ok(newOwnership.config_text.includes("// synthetic operator sentinel: preserve this comment"));
  assert.deepEqual(owner.permissions.leaves.map((leaf) => ({ path: leaf.path, value: leaf.value }))
    .sort((left, right) => left.path.join(".").localeCompare(right.path.join("."))), [
    { path: ["permission", "memocap_read", "library"], value: "allow" },
    { path: ["permission", "memocap_recall", "library"], value: "allow" },
  ]);
  const listed = await cli(["list", "--limit", "100"]);
  assert.deepEqual([...listed.returned_ids].sort((left, right) => left - right), before.tables.memories.map((row) => row.id).sort((left, right) => left - right));
  const activity = await cli(["activity", "list", "--limit", "100"]);
  const observedOperations = new Set(activity.events.map((event) => event.operation_id));
  for (const row of before.tables.activity_events) assert.ok(observedOperations.has(row.operation_id));
  evidence.assertions.push("new CLI/schema/activity/policy/grants independently verified; old business rows and history retained");
  const beforeRepeat = databaseSnapshot(env.MEMOCAP_DB);
  const repeatOwnership = await managedSnapshot(fixture, config);
  const repeated = await setup(newSetup, ["update", "--to", "0.6.0", "--yes"]);
  assert.equal(repeated.readiness, "static_ready");
  assert.deepEqual(databaseSnapshot(env.MEMOCAP_DB), beforeRepeat);
  assert.deepEqual(await managedSnapshot(fixture, config), repeatOwnership);
  evidence.idempotent = { report: repeated, database: databaseSnapshot(env.MEMOCAP_DB), ownership: await managedSnapshot(fixture, config) };
  assert.equal(fs.existsSync(fixture.guardLog), false);
  assert.ok(evidence.registry_requests.some((request) => request.method === "GET" &&
    decodeURIComponent(request.url) === "/@lyy-gh/memocap"));
  evidence.assertions.push("installed package files match the verified local tarball; npm may reuse its integrity cache");
  evidence.assertions.push("same-version authorized update preserves semantic database, configuration and managed ownership");
}

module.exports = { runScenario };
