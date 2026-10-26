"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { lifecycleFixture, write, snapshot } = require("./setup-package-lifecycle-fixture.cjs");
const { assertManagedLinks } = require("./packaged-runtime.cjs");

async function runLifecycle(fixture, prepared, evidence) {
  const { home, prefix, project, env, command, version, installedRoot } = fixture;
  const config = path.join(env.XDG_CONFIG_HOME, "opencode/opencode.json");
  const original = '{\n // retain operator settings\n "model": "wire/wire-model",\n "share": "disabled",\n "plugin": [],\n "skills": {"paths": []}\n}\n';
  write(config, original);
  const setup = async (args, options = {}) => {
    const entry = path.join(options.bootstrap ? prepared.runnerRoot : installedRoot, "scripts/setup.mjs");
    const result = await command(process.execPath, [entry, ...args, "--json"], { allowFailure: true, ...options });
    const report = JSON.parse(result.stdout);
    assert.equal(result.code, report.exit_code);
    return report;
  };
  const passed = (name) => evidence.assertions.push(name);
  const successful = (report) => { assert.equal(report.exit_code, 0, JSON.stringify(report)); return report; };
  let before = snapshot([home, project, prefix, env.MEMOCAP_DATA_DIR]);
  successful(await setup(["install", "--global", "--dry-run"], { bootstrap: true }));
  assert.deepEqual(snapshot([home, project, prefix, env.MEMOCAP_DATA_DIR]), before);
  passed("actual installed tarball runner dry-run preserves HOME/project/prefix/database");

  const preload = path.join(fixture.root, "fail-config.cjs");
  write(preload, `const fs=require('node:fs');const original=fs.renameSync;fs.renameSync=function(source,destination){if(destination===process.env.MEMOCAP_FIXTURE_CONFIG)throw Object.assign(new Error('fixture config CAS interruption'),{code:'EACCES'});return original.apply(this,arguments);};\n`);
  const partial = await setup(["install", "--global", "--yes"], { bootstrap: true,
    env: { NODE_OPTIONS: `${env.NODE_OPTIONS || ""} --require=${JSON.stringify(preload)}`.trim(), MEMOCAP_FIXTURE_CONFIG: config } });
  assert.equal(partial.status, "partial", JSON.stringify(partial));
  assert.ok(partial.steps.some((step) => step.component === "cli" && step.status === "changed"));
  assert.equal(fs.existsSync(env.MEMOCAP_DB), false);
  const resumed = successful(await setup(["install", "--global", "--yes"]));
  assert.equal(resumed.readiness, "static_ready");
  assert.equal(resumed.runtime.status, "not_run");
  assert.equal(resumed.steps.find((step) => step.component === "cli").status, "unchanged");
  passed("real setup subprocess recovers config-CAS interruption without reinstalling CLI");

  const { inspectPolicy } = await import(pathToFileURL(path.join(installedRoot, "lib/policy.mjs")));
  const { createRequire } = require("node:module");
  const jsonc = createRequire(path.join(installedRoot, "package.json"))("jsonc-parser");
  const managed = jsonc.parse(fs.readFileSync(config, "utf8")).plugin.find((entry) => Array.isArray(entry) && entry[0] === `@lyy-gh/memocap@${version}`)[1].skillDirectory;
  const bundled = inspectPolicy(path.join(installedRoot, "skills/memocap"));
  const observed = inspectPolicy(managed);
  assert.equal(observed.digest, bundled.digest);
  assert.deepEqual(observed.files, bundled.files);
  assert.ok(observed.files.some((file) => file.path.startsWith("references/")));
  for (const file of observed.files) assert.equal(fs.lstatSync(path.join(managed, file.path)).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(home, ".agents/skills/memocap")), false);
  const manifestFile = resumed.manifest_path;
  assert.equal(JSON.parse(fs.readFileSync(manifestFile)).format_version, 2);
  evidence.policy = { version, digest: observed.digest, files: observed.files, ordinary_copy: true };
  assert.equal((await command("memocap", ["--version"])).stdout.trim(), `memocap ${version}`);
  const resolved = await command(process.execPath, ["-e", "console.log(require.resolve('jsonc-parser',{paths:[process.argv[1]]}))", installedRoot]);
  assert.ok(fs.realpathSync(resolved.stdout.trim()).startsWith(fs.realpathSync(prefix) + path.sep));
  passed("actual global package resolves dependencies and full ordinary managed payload without canonical skills");

  const watched = [home, project, prefix, env.MEMOCAP_DATA_DIR];
  before = snapshot(watched);
  for (const args of [["check", "--global"], ["doctor", "--global"], ["update", "--to", version, "--global", "--dry-run"], ["update", "--to", version, "--global", "--yes"]]) {
    successful(await setup(args));
    assert.deepEqual(snapshot(watched), before, args.join(" "));
  }
  passed("check/doctor/exact update preserve all persistent bytes");
  const reused = successful(await setup(["install", "--project", project, "--yes"]));
  assert.equal(reused.scopes[0].owner_reused, true, JSON.stringify(reused.scopes));
  assert.deepEqual(snapshot(watched), before);
  passed("project install reuses exact global owner without a second payload or registration");

  const remembered = JSON.parse((await command("memocap", ["remember", "packaged lifecycle sentinel", "--repo", project, "--json"])).stdout);
  assert.equal(remembered.status, "inserted");
  const recalled = JSON.parse((await command("memocap", ["recall", "packaged lifecycle", "--match", "all", "--repo", project, "--json"])).stdout);
  assert.ok(recalled.returned_ids.includes(remembered.returned_ids[0]));
  write(path.join(env.MEMOCAP_DATA_DIR, "backup.sentinel"), "retain backup bytes\n");
  const memory = snapshot([env.MEMOCAP_DATA_DIR]);
  successful(await setup(["uninstall", "--global", "--yes"]));
  assert.deepEqual(snapshot([env.MEMOCAP_DATA_DIR]), memory);
  assert.deepEqual(jsonc.parse(fs.readFileSync(config, "utf8")), jsonc.parse(original));
  assert.ok(fs.readFileSync(config, "utf8").includes("// retain operator settings"));
  assert.equal(fs.existsSync(managed), false);
  passed("uninstall removes only owned payload and preserves JSONC/settings/database/backup");

  await require("./setup-package-legacy.cjs").legacyMissing(fixture, prepared, evidence);
  successful(await setup(["uninstall", "--global", "--yes"]));

  const custom = path.join(fixture.root, "custom config directory");
  successful(await setup(["install", "--global", "--yes"], { env: { OPENCODE_CONFIG_DIR: custom } }));
  const customConfig = path.join(custom, "opencode.jsonc");
  const customParsed = jsonc.parse(fs.readFileSync(customConfig, "utf8"));
  const customPolicy = customParsed.plugin.find((entry) => Array.isArray(entry))[1].skillDirectory;
  assert.ok(customPolicy.startsWith(fs.realpathSync(custom) + path.sep));
  assert.equal(inspectPolicy(customPolicy).digest, bundled.digest);
  successful(await setup(["uninstall", "--global", "--yes"], { env: { OPENCODE_CONFIG_DIR: custom } }));
  assert.equal(fs.existsSync(customPolicy), false);
  passed("custom OPENCODE_CONFIG_DIR owns and removes its ordinary payload");

  const projectReport = successful(await setup(["install", "--project", project, "--yes"]));
  const projectConfig = projectReport.scopes[0].config;
  const projectParsed = jsonc.parse(fs.readFileSync(projectConfig, "utf8"));
  const projectPolicy = projectParsed.plugin.find((entry) => Array.isArray(entry))[1].skillDirectory;
  const otherProject = path.join(fixture.root, "other project");
  const otherConfig = path.join(otherProject, "opencode.json");
  fs.mkdirSync(otherProject);
  fs.copyFileSync(projectConfig, otherConfig);
  const sharedManifest = JSON.parse(fs.readFileSync(manifestFile));
  const originalRecord = sharedManifest.installs[projectReport.scopes[0].id];
  sharedManifest.installs[`project:${fs.realpathSync(otherProject)}`] = {
    ...structuredClone(originalRecord), directory: fs.realpathSync(otherProject), config: otherConfig,
  };
  write(manifestFile, JSON.stringify(sharedManifest));
  const sharedBytes = snapshot([projectPolicy, otherConfig]);
  const removed = successful(await setup(["uninstall", "--project", project, "--yes"]));
  assert.equal(removed.steps.find((step) => step.component === "skill_removal")?.status, "retained_shared", JSON.stringify(removed));
  assert.deepEqual(snapshot([projectPolicy, otherConfig]), sharedBytes);
  successful(await setup(["uninstall", "--project", otherProject, "--yes"]));
  assert.equal(fs.existsSync(projectPolicy), false);
  fs.rmSync(otherProject, { recursive: true });
  passed("actual project uninstall retains seeded second-owner bytes then removes the final reference");

  successful(await setup(["install", "--project", project, "--yes"]));
  const reference = bundled.files.find((file) => file.path.startsWith("references/"));
  fs.appendFileSync(path.join(projectPolicy, reference.path), "\nfixture operator modification\n");
  const modified = snapshot([projectPolicy]);
  const doctor = await setup(["doctor", "--project", project]);
  assert.equal(doctor.error.code, "skill_modified");
  const retained = successful(await setup(["uninstall", "--project", project, "--yes"]));
  assert.ok(retained.steps.some((step) => step.status === "retained_modified"));
  assert.deepEqual(snapshot([projectPolicy]), modified);
  fs.rmSync(projectPolicy, { recursive: true });
  passed("reference-only tampering fails doctor and uninstall retains modified bytes");

  successful(await setup(["install", "--global", "--yes"]));
  assert.equal(fs.existsSync(fixture.guardLog), false, "default lifecycle must make zero npx/skills calls");
  evidence.default_skills_cli = { fail_guard_enabled: true, calls: 0 };
  if (fixture.deniedLinks) {
    evidence.windows_copy = assertManagedLinks(fixture.deniedLinks);
  }
  return { setup, config, managed, bundled, manifestFile };
}

async function main() {
  const workspace = path.resolve(__dirname, "..");
  const evidence = { format_version: 1, started_at: new Date().toISOString(), platform: process.platform,
    arch: process.arch, node: process.version, commands: [], assertions: [], cleanup: {}, status: "running" };
  const fixture = lifecycleFixture(workspace, evidence);
  try {
    await runLifecycle(fixture, await fixture.prepare(), evidence);
    evidence.status = "passed";
  } catch (error) { evidence.status = "failed"; evidence.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
  finally {
    evidence.cleanup = await fixture.cleanup();
    evidence.finished_at = new Date().toISOString();
    const filename = process.env.MEMOCAP_TEST_LIFECYCLE_EVIDENCE || path.join(workspace, ".omo/evidence/memocap-unified-skill/task-8-lifecycle.json");
    write(filename, `${JSON.stringify(evidence, null, 2)}\n`);
    assert.equal(JSON.parse(fs.readFileSync(filename)).status, evidence.status);
    console.log(JSON.stringify({ status: evidence.status, assertions: evidence.assertions.length, failure: evidence.failure?.message, evidence: filename }));
  }
}

module.exports = { runLifecycle };
if (require.main === module) main();
