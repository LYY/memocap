"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { lifecycleFixture, digest, write, snapshot } = require("./setup-package-lifecycle-fixture.cjs");

const workspace = path.resolve(__dirname, "..");
const packageVersion = require("../package.json").version;
const evidencePath = path.join(workspace, ".omo/evidence/memocap-v020-single-database/task-6-tracked-lifecycle.json");
const evidence = { format_version: 1, started_at: new Date().toISOString(), commands: [], assertions: [], failures: [],
  scope: "manual Darwin arm64 / invoking Node 24 / package 0.2.0 / schema 2.0; prepublication local fixture",
  source_hashes: Object.fromEntries([__filename, path.join(__dirname, "setup-package-lifecycle-fixture.cjs")].map((filename) => [path.relative(workspace, filename), digest(fs.readFileSync(filename))])),
  boundary: { npm: "loopback registry serves actual npm pack artifact; other package requests redirect to registry.npmjs.org",
    skills: "real skills@1.7.4; unpublished GitHub release URL rewritten only at git transport to sandbox release refs built from unpacked tarball",
    binary: "prepublish_local: copied current target/debug/memocap with locally computed checksum; published release asset NOT verified" },
  not_run: ["published npm/tag/provenance acceptance", "plugin host/runtime", "native Windows/PowerShell", "native Linux", "pnpm installation"],
  prior_integration: ".omo/evidence/memocap-v020-single-database/task-6-integration.json" };

async function main() {
  const fixture = lifecycleFixture(workspace, evidence);
  const { home, prefix, project, localSkillProject, env, command } = fixture;

  async function scenario(name, action) {
    try { await action(); evidence.assertions.push({ name, status: "passed" }); }
    catch (error) { evidence.failures.push({ name, message: error.message, stack: error.stack }); }
  }

  try {
    const { payload, failClone, gitLog } = await fixture.prepare();
    const config = path.join(env.XDG_CONFIG_HOME, "opencode/opencode.jsonc");
    const originalConfig = '{\n // preserve operator settings\n "model": "fixture/model",\n "plugin": [["other-plugin@1", {"enabled": true}]]\n}\n';
    write(config, originalConfig);
    const bootstrap = ["--yes", "--package", `@lyy-gh/memocap@${packageVersion}`, "memocap-setup"];
    const setup = async (args, options = {}) => {
      const receipt = await command(options.bootstrap ? "npx" : "memocap-setup", options.bootstrap ? [...bootstrap, ...args, "--json"] : [...args, "--json"], { allowFailure: true });
      const report = JSON.parse(receipt.stdout);
      assert.equal(receipt.code, report.exit_code);
      return report;
    };
    let installed;
    await scenario("real npx pinned runner dry-run before global install leaves core/config/skill/manifest unchanged", async () => {
      const watched = [home, project];
      const before = snapshot(watched);
      const report = await setup(["install", "--global", "--dry-run"], { bootstrap: true });
      assert.equal(report.exit_code, 0, JSON.stringify(report));
      assert.equal(report.runner_version, packageVersion);
      assert.deepEqual(snapshot(watched), before);
      evidence.bootstrap_cache = { path: env.npm_config_cache, excluded_from_core_snapshot: true, exists: fs.existsSync(env.npm_config_cache) };
    });
    await scenario("actual setup subprocess installs CLI/plugin then fails on external skill clone and resumes", async () => {
      write(failClone, "external transport failure");
      const partial = await setup(["install", "--global", "--yes"], { bootstrap: true });
      assert.equal(partial.status, "partial", JSON.stringify(partial));
      assert.equal(partial.shared_cli.executable_version, packageVersion);
      assert.equal(partial.scopes[0].plugin.status, "configured");
      assert.ok(partial.steps.some((step) => step.component === "skill" && ["failed", "outcome_unknown"].includes(step.status)));
      assert.equal(fs.existsSync(env.MEMOCAP_DB), false);
      assert.equal(partial.steps.some((step) => step.component === "backend" && step.status === "changed"), false);
      const packageBefore = snapshot([path.join(prefix, "lib/node_modules/@lyy-gh/memocap")]);
      fs.unlinkSync(failClone);
      installed = await setup(["install", "--global", "--yes"]);
      assert.equal(installed.exit_code, 0, JSON.stringify(installed));
      assert.equal(installed.readiness, "static_ready");
      assert.deepEqual(snapshot([path.join(prefix, "lib/node_modules/@lyy-gh/memocap")]), packageBefore);
      assert.equal(installed.steps.find((step) => step.component === "cli").status, "unchanged");
      assert.equal(installed.runtime.status, "not_run");
      assert.equal(fs.existsSync(env.MEMOCAP_DB), true);
      const inspected = JSON.parse((await command("memocap", ["status", "--read-only", "--json"])).stdout);
      assert.equal(inspected.inspection.core_status, "ready");
      assert.equal(inspected.inspection.schema_version, "2.0");
      assert.equal(inspected.inspection.activity_status, "ready");
      assert.equal(fs.existsSync(`${env.MEMOCAP_DB}.activity.sqlite`), false);
      evidence.partial_resume = { partial, resumed: installed };
    });
    const installedRoot = path.join(prefix, "lib/node_modules/@lyy-gh/memocap");
    const watched = [home, project, prefix];
    await scenario("installed package resolves dependencies without checkout node_modules and actual bin/wrapper preserve argv", async () => {
      assert.equal(fs.realpathSync(path.join(prefix, "bin/memocap-setup")), fs.realpathSync(path.join(installedRoot, "scripts/setup.mjs")));
      const resolved = await command("node", ["-e", "console.log(require.resolve('jsonc-parser',{paths:[process.argv[1]]}))", installedRoot]);
      assert.ok(resolved.stdout.trim().startsWith(fs.realpathSync(prefix) + path.sep), resolved.stdout);
      const version = await command("memocap", ["--version"]);
      assert.equal(version.stdout.trim(), `memocap ${packageVersion}`);
      await command("sh", ["-n", path.join(installedRoot, "scripts/install.sh")]);
      const literal = "literal'\"$(touch SHOULD_NOT_EXIST); with spaces";
      const wrapped = await command("sh", [path.join(installedRoot, "scripts/install.sh"), "install", "--project", project, literal, "--json"], { allowFailure: true });
      assert.equal(wrapped.code, 1);
      assert.ok(JSON.parse(wrapped.stdout).error.message.includes(literal));
      assert.equal(fs.existsSync(path.join(project, "SHOULD_NOT_EXIST")), false);
      const help = await command("sh", [path.join(installedRoot, "scripts/install.sh"), "--help", "--json"]);
      assert.equal(JSON.parse(help.stdout).runner_version, packageVersion);
    });
    await scenario("installed check/doctor/exact update no-op preserve all home/project/prefix bytes", async () => {
      const before = snapshot(watched);
      for (const args of [["check", "--global"], ["doctor", "--global"], ["update", "--to", packageVersion, "--global", "--dry-run"], ["update", "--to", packageVersion, "--global", "--yes"]]) {
        const report = await setup(args);
        assert.equal(report.exit_code, 0, JSON.stringify(report));
        if (args[0] === "update" && args.includes("--yes")) assert.equal(report.status, "unchanged");
        assert.deepEqual(snapshot(watched), before, args.join(" "));
      }
      evidence.checkNoMutation = { watched: ["entire sandbox HOME (memory/config/skills/manifest)", "project", "npm prefix"], unchanged: true,
        excluded: ["npm/npx cache outside HOME, explicitly allowed runner loader cache", "temporary process files"], core: "schema 2.0 created by explicit install preparation; read-only checks and exact update preserve bytes" };
    });
    await scenario("real pinned skills installs directly from unpacked tarball local directory", async () => {
      await command("npx", ["--yes", "skills@1.7.4", "add", payload, "--skill", "memocap", "--agent", "opencode", "--yes"], { cwd: localSkillProject });
      const canonical = path.join(localSkillProject, ".agents/skills/memocap/SKILL.md");
      assert.equal(fs.readFileSync(canonical, "utf8"), fs.readFileSync(path.join(payload, "skills/memocap/SKILL.md"), "utf8"));
      const listed = await command("npx", ["--yes", "skills@1.7.4", "list", "--json"], { cwd: localSkillProject });
      assert.ok(JSON.parse(listed.stdout).some((skill) => skill.name === "memocap"));
    });
    await scenario("human/agent project commands install scoped config and owned skill then uninstall preserving unrelated config", async () => {
      const report = await setup(["install", "--project", project, "--yes"]);
      assert.equal(report.exit_code, 0, JSON.stringify(report));
      assert.equal(report.scopes[0].kind, "project");
      const filename = report.scopes[0].config;
      const contents = JSON.parse(fs.readFileSync(filename));
      contents.model = "project/keep";
      write(filename, JSON.stringify(contents));
      const removed = await setup(["uninstall", "--project", project, "--yes"]);
      assert.equal(removed.exit_code, 0, JSON.stringify(removed));
      assert.equal(JSON.parse(fs.readFileSync(filename)).model, "project/keep");
      assert.equal(fs.existsSync(path.join(project, ".agents/skills/memocap")), false);
      assert.equal(fs.existsSync(path.join(prefix, "bin/memocap")), true);
    });
    await scenario("actual memory write/recall then uninstall retains database and unrelated global config", async () => {
      const remembered = await command("memocap", ["remember", "packaged lifecycle unique receipt", "--repo", project, "--json"]);
      const receipt = JSON.parse(remembered.stdout);
      assert.equal(receipt.status, "inserted", remembered.stdout);
      const recalled = await command("memocap", ["recall", "packaged lifecycle", "--match", "all", "--repo", project, "--json"]);
      assert.ok(JSON.parse(recalled.stdout).returned_ids.length > 0);
      await command("node", ["-e", "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);try{db.exec('PRAGMA journal_mode=DELETE;')}finally{db.close();}", env.MEMOCAP_DB]);
      const rollbackBefore = snapshot([path.dirname(env.MEMOCAP_DB)]);
      const checked = await setup(["check", "--to", packageVersion, "--global"]);
      assert.equal(checked.exit_code, 0, JSON.stringify(checked));
      assert.equal(checked.readiness, "static_ready");
      assert.deepEqual(snapshot([path.dirname(env.MEMOCAP_DB)]), rollbackBefore);
      evidence.rollback_journal_inspection = { status: "passed", fixture_owned: true, core_schema: checked.backend.core_schema, memory_directory_unchanged: true };
      const database = snapshot([path.dirname(env.MEMOCAP_DB)]);
      const removed = await setup(["uninstall", "--global", "--yes"]);
      assert.equal(removed.exit_code, 0, JSON.stringify(removed));
      assert.deepEqual(snapshot([path.dirname(env.MEMOCAP_DB)]), database);
      const text = fs.readFileSync(config, "utf8");
      assert.ok(text.includes("// preserve operator settings"));
      const { createRequire } = require("node:module");
      const jsonc = createRequire(path.join(installedRoot, "package.json"))("jsonc-parser");
      assert.deepEqual(jsonc.parse(text), jsonc.parse(originalConfig));
      evidence.database_preserved = { sha256: digest(fs.readFileSync(env.MEMOCAP_DB)), uninstall: "full memory directory including activity unchanged" };
    });
    await scenario("shared real agent skill prevents destructive CLI removal", async () => {
      env.MEMOCAP_DB = path.join(home, "second missing/core.db");
      const report = await setup(["install", "--global", "--yes"]);
      assert.equal(report.exit_code, 0, JSON.stringify(report));
      await command("npx", ["--yes", "skills@1.7.4", "add", `https://github.com/LYY/memocap/tree/v${packageVersion}`, "--skill", "memocap", "--agent", "claude-code", "--global", "--yes"]);
      const skill = path.join(home, ".agents/skills/memocap");
      const before = snapshot([skill, path.join(home, ".claude/skills/memocap")]);
      const removed = await setup(["uninstall", "--global", "--remove-cli", "--yes"]);
      assert.equal(removed.exit_code, 1, JSON.stringify(removed));
      assert.equal(removed.error.code, "duplicate_skill");
      assert.deepEqual(snapshot([skill, path.join(home, ".claude/skills/memocap")]), before);
      assert.equal(fs.existsSync(path.join(prefix, "bin/memocap")), true);
      evidence.observations = [{ code: "actual_skills_copied_agent_layout", behavior: "skills@1.7.4 copies Claude Code skill; default external discovery yields duplicate_skill before uninstall and preserves both copies and CLI", status: "safe refusal; shared uninstall requires resolving duplicate discovery" }];
      env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
      const retained = await setup(["uninstall", "--global", "--remove-cli", "--yes"]);
      assert.equal(retained.error.code, "cli_references_remain", JSON.stringify(retained));
      assert.ok(retained.steps.some((step) => step.status === "retained_shared"));
      assert.deepEqual(snapshot([skill, path.join(home, ".claude/skills/memocap")]), before);
      evidence.shared_retention = { status: "retained_shared", claude_external_discovery_disabled: true, inventory_real: true, canonical_and_other_agent_unchanged: true };
      await command("npx", ["--yes", "skills@1.7.4", "remove", "memocap", "--agent", "claude-code", "--global", "--yes"]);
      const final = await setup(["uninstall", "--global", "--remove-cli", "--yes"]);
      assert.equal(final.exit_code, 0, JSON.stringify(final));
      assert.equal(fs.existsSync(path.join(prefix, "bin/memocap")), false);
    });
    evidence.git_transport_calls = fs.existsSync(gitLog) ? fs.readFileSync(gitLog, "utf8").trim().split("\n").map(JSON.parse) : [];
  } catch (error) {
    evidence.failures.push({ name: "harness prerequisite", message: error.message, stack: error.stack });
  } finally {
    evidence.cleanup = await fixture.cleanup();
    evidence.DoneClaim = { packaging: evidence.failures.length === 0 ? "passed_prepublication_local_boundary" : "failed_see_receipts", runtime_verified: false,
      release_ready: false, changed_files: ["tests/setup-package-lifecycle.cjs", "tests/setup-package-lifecycle-fixture.cjs"], evidence: path.relative(workspace, evidencePath) };
    evidence.finished_at = new Date().toISOString();
    write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    assert.equal(JSON.parse(fs.readFileSync(evidencePath)).finished_at, evidence.finished_at);
    console.log(JSON.stringify({ assertions: evidence.assertions, failures: evidence.failures.map(({ name, message }) => ({ name, message: message.slice(0, 1500) })), evidence: evidencePath, cleanup: evidence.cleanup }, null, 2));
    process.exitCode = evidence.failures.length ? 1 : 0;
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
