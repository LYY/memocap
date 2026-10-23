"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const workspace = path.resolve(__dirname, "..");
const evidencePath = path.join(workspace, ".omo/evidence/memocap-observable-opencode-v1/packaged-lifecycle.json");
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const evidence = { format_version: 1, started_at: new Date().toISOString(), commands: [], assertions: [], failures: [],
  boundary: { npm: "loopback registry serves actual npm pack artifact; other package requests redirect to registry.npmjs.org",
    skills: "real skills@1.7.4; unpublished GitHub release URL rewritten only at git transport to sandbox release refs built from unpacked tarball",
    binary: "prepublish_local: copied current target/debug/memocap with locally computed checksum; published release asset NOT verified" },
  not_run: ["published npm/tag/provenance acceptance", "plugin host/runtime", "native Windows/PowerShell", "native Linux", "pnpm installation", "normal WAL acceptance: parent-owned readonly fix pending"] };
if (fs.existsSync(evidencePath)) {
  const prior = JSON.parse(fs.readFileSync(evidencePath));
  evidence.reproductions = prior.reproductions || [];
  if (prior.failures.length) evidence.reproductions.push({ started_at: prior.started_at, failures: prior.failures.map(({ name, message }) => ({ name, message })),
    commands: prior.commands.filter((receipt) => receipt.executable === "npx" && receipt.args.includes("memocap-setup")) });
}

function write(filename, contents) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function snapshot(roots) {
  const entries = {};
  function visit(filename) {
    if (!fs.existsSync(filename)) return;
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) entries[filename] = `symlink:${fs.readlinkSync(filename)}`;
    else if (stat.isDirectory()) {
      entries[filename] = "directory";
      for (const name of fs.readdirSync(filename).sort()) visit(path.join(filename, name));
    } else entries[filename] = digest(fs.readFileSync(filename));
  }
  roots.forEach(visit);
  return entries;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap packed lifecycle "));
  const home = path.join(root, "home");
  const prefix = path.join(root, "package prefix");
  const tools = path.join(root, "tools");
  const bins = path.join(root, "boundary bin");
  const project = path.join(root, "project with spaces ' $() ; literal");
  const localSkillProject = path.join(root, "local payload project");
  for (const directory of [home, prefix, tools, bins, project, localSkillProject]) fs.mkdirSync(directory, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"), XDG_DATA_HOME: path.join(home, "data"), TMPDIR: path.join(root, "tmp"),
    PATH: [bins, path.join(prefix, "bin"), path.join(tools, "bin"), "/usr/bin", "/bin"].join(path.delimiter),
    npm_config_prefix: prefix, npm_config_cache: path.join(root, "npm cache"), npm_config_userconfig: path.join(root, "npmrc"),
    npm_config_globalconfig: path.join(root, "global-npmrc"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", CI: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0", MEMOCAP_DB: path.join(home, "memory/core.db"), LANG: "en_US.UTF-8" };
  fs.mkdirSync(env.TMPDIR);
  for (const command of ["node", "npm", "npx"]) fs.symlinkSync(`/opt/homebrew/bin/${command}`, path.join(bins, command));
  const binary = path.join(root, "local native 0.1.0");
  fs.copyFileSync(path.join(workspace, "target/debug/memocap"), binary);
  fs.chmodSync(binary, 0o755);
  evidence.binary = { source: "target/debug/memocap", sha256: digest(fs.readFileSync(binary)), origin: "prepublish_local" };
  let server;

  async function command(executable, args, options = {}) {
    const cwd = options.cwd || project;
    const childEnv = { ...env, ...options.env };
    const started = Date.now();
    const receipt = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    evidence.commands.push({ executable, args, cwd, ...receipt, elapsed_ms: Date.now() - started });
    if (!options.allowFailure) assert.equal(receipt.code, 0, `${executable} ${args.join(" ")}\n${receipt.stderr}\n${receipt.stdout}`);
    return receipt;
  }

  async function scenario(name, action) {
    try { await action(); evidence.assertions.push({ name, status: "passed" }); }
    catch (error) { evidence.failures.push({ name, message: error.message, stack: error.stack }); }
  }

  try {
    const version = await command(binary, ["--version"]);
    assert.equal(version.stdout.trim(), "memocap 0.1.0");
    const packed = await command("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: workspace });
    const metadata = JSON.parse(packed.stdout)[0];
    const tarball = path.join(root, metadata.filename);
    const bytes = fs.readFileSync(tarball);
    evidence.pack = { ...metadata, sha256: digest(bytes) };
    const unpack = path.join(root, "unpacked tarball");
    fs.mkdirSync(unpack);
    await command("tar", ["-xzf", tarball, "-C", unpack]);
    const payload = path.join(unpack, "package");
    const source = path.join(root, "release fixture");
    fs.mkdirSync(source);
    fs.cpSync(path.join(payload, "skills"), path.join(source, "skills"), { recursive: true });
    const git = "/opt/homebrew/bin/git";
    await command(git, ["init", "--quiet", source]);
    await command(git, ["-C", source, "add", "skills"]);
    await command(git, ["-C", source, "-c", "user.name=Sandbox Fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Unpacked tarball skill fixture"]);
    await command(git, ["-C", source, "tag", "v0.1.0"]);
    write(env.GIT_CONFIG_GLOBAL, `[url "file://${source}/"]\n  insteadOf = https://github.com/LYY/memocap.git\n[protocol "file"]\n  allow = always\n`);
    const failClone = path.join(root, "fail clone");
    const gitLog = path.join(root, "git calls.jsonl");
    write(path.join(bins, "git"), `#!${process.execPath}\nconst fs=require('node:fs');const {spawnSync}=require('node:child_process');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(gitLog)},JSON.stringify(args)+'\\n');if(args.includes('clone')&&fs.existsSync(${JSON.stringify(failClone)})){process.stderr.write('sandbox unpublished release transport failure\\n');process.exit(73);}const child=spawnSync(${JSON.stringify(git)},args,{stdio:'inherit',env:process.env});process.exit(child.status??1);\n`);
    fs.chmodSync(path.join(bins, "git"), 0o755);
    const requests = [];
    server = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (request.url === "/memocap.tgz") { response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(bytes); return; }
      if (decodeURIComponent(request.url).startsWith("/@lyy-gh/memocap")) {
        const versionMetadata = { ...JSON.parse(fs.readFileSync(path.join(payload, "package.json"))), dist: {
          tarball: `http://127.0.0.1:${server.address().port}/memocap.tgz`, integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` } };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: "@lyy-gh/memocap", "dist-tags": { latest: "0.1.0" }, versions: { "0.1.0": versionMetadata } }));
      } else { response.writeHead(302, { location: `https://registry.npmjs.org${request.url}` }); response.end(); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    env.npm_config_registry = `http://127.0.0.1:${server.address().port}`;
    evidence.registry_requests = requests;
    await command("npm", ["install", "--global", "--prefix", tools, "opencode-ai@1.19.3", "--registry", "https://registry.npmjs.org"]);
    await command("opencode", ["--version"]);
    const cache = path.join(home, "Library/Caches/memocap/0.1.0");
    const asset = "memocap-aarch64-apple-darwin";
    fs.mkdirSync(cache, { recursive: true });
    fs.copyFileSync(binary, path.join(cache, asset));
    write(path.join(cache, `${asset}.sha256`), `${evidence.binary.sha256}  ${asset}\n`);
    const config = path.join(env.XDG_CONFIG_HOME, "opencode/opencode.jsonc");
    const originalConfig = '{\n // preserve operator settings\n "model": "fixture/model",\n "plugin": [["other-plugin@1", {"enabled": true}]]\n}\n';
    write(config, originalConfig);
    const bootstrap = ["--yes", "--package", "@lyy-gh/memocap@0.1.0", "memocap-setup"];
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
      assert.equal(report.runner_version, "0.1.0");
      assert.deepEqual(snapshot(watched), before);
      evidence.bootstrap_cache = { path: env.npm_config_cache, excluded_from_core_snapshot: true, exists: fs.existsSync(env.npm_config_cache) };
    });
    await scenario("actual setup subprocess installs CLI/plugin then fails on external skill clone and resumes", async () => {
      write(failClone, "external transport failure");
      const partial = await setup(["install", "--global", "--yes"], { bootstrap: true });
      assert.equal(partial.status, "partial", JSON.stringify(partial));
      assert.equal(partial.shared_cli.executable_version, "0.1.0");
      assert.equal(partial.scopes[0].plugin.status, "configured");
      assert.ok(partial.steps.some((step) => step.component === "skill" && ["failed", "outcome_unknown"].includes(step.status)));
      const packageBefore = snapshot([path.join(prefix, "lib/node_modules/@lyy-gh/memocap")]);
      fs.unlinkSync(failClone);
      installed = await setup(["install", "--global", "--yes"]);
      assert.equal(installed.exit_code, 0, JSON.stringify(installed));
      assert.equal(installed.readiness, "installation_ready");
      assert.deepEqual(snapshot([path.join(prefix, "lib/node_modules/@lyy-gh/memocap")]), packageBefore);
      assert.equal(installed.steps.find((step) => step.component === "cli").status, "unchanged");
      assert.equal(installed.runtime.status, "not_run");
      assert.equal(fs.existsSync(env.MEMOCAP_DB), false);
      evidence.partial_resume = { partial, resumed: installed };
    });
    const installedRoot = path.join(prefix, "lib/node_modules/@lyy-gh/memocap");
    const watched = [home, project, prefix];
    await scenario("installed package resolves dependencies without checkout node_modules and actual bin/wrapper preserve argv", async () => {
      assert.equal(fs.realpathSync(path.join(prefix, "bin/memocap-setup")), fs.realpathSync(path.join(installedRoot, "scripts/setup.mjs")));
      const resolved = await command("node", ["-e", "console.log(require.resolve('jsonc-parser',{paths:[process.argv[1]]}))", installedRoot]);
      assert.ok(resolved.stdout.trim().startsWith(fs.realpathSync(prefix) + path.sep), resolved.stdout);
      const version = await command("memocap", ["--version"]);
      assert.equal(version.stdout.trim(), "memocap 0.1.0");
      await command("sh", ["-n", path.join(installedRoot, "scripts/install.sh")]);
      const literal = "literal'\"$(touch SHOULD_NOT_EXIST); with spaces";
      const wrapped = await command("sh", [path.join(installedRoot, "scripts/install.sh"), "install", "--project", project, literal, "--json"], { allowFailure: true });
      assert.equal(wrapped.code, 1);
      assert.ok(JSON.parse(wrapped.stdout).error.message.includes(literal));
      assert.equal(fs.existsSync(path.join(project, "SHOULD_NOT_EXIST")), false);
      const help = await command("sh", [path.join(installedRoot, "scripts/install.sh"), "--help", "--json"]);
      assert.equal(JSON.parse(help.stdout).runner_version, "0.1.0");
    });
    await scenario("installed check/doctor/exact update no-op preserve all home/project/prefix bytes", async () => {
      const before = snapshot(watched);
      for (const args of [["check", "--global"], ["doctor", "--global"], ["update", "--to", "0.1.0", "--global", "--dry-run"], ["update", "--to", "0.1.0", "--global", "--yes"]]) {
        const report = await setup(args);
        assert.equal(report.exit_code, 0, JSON.stringify(report));
        if (args[0] === "update" && args.includes("--yes")) assert.equal(report.status, "unchanged");
        assert.deepEqual(snapshot(watched), before, args.join(" "));
      }
      evidence.checkNoMutation = { watched: ["entire sandbox HOME (memory/config/skills/manifest)", "project", "npm prefix"], unchanged: true,
        excluded: ["npm/npx cache outside HOME, explicitly allowed runner loader cache", "temporary process files"], core: "absent, not initialized by installer" };
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
      await command("sqlite3", [env.MEMOCAP_DB, "PRAGMA journal_mode=DELETE;"]);
      const rollbackBefore = snapshot([path.dirname(env.MEMOCAP_DB)]);
      const checked = await setup(["check", "--to", "0.1.0", "--global"]);
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
      await command("npx", ["--yes", "skills@1.7.4", "add", "https://github.com/LYY/memocap/tree/v0.1.0", "--skill", "memocap", "--agent", "claude-code", "--global", "--yes"]);
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
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    evidence.cleanup = { sandbox_removed: !fs.existsSync(root), loopback_server_closed: !server?.listening, personal_config_or_memory_used: false,
      git_writes: "sandbox release fixture refs only; no worktree/index/branch changes in user repository" };
    evidence.DoneClaim = { packaging: evidence.failures.length === 0 ? "passed_prepublication_local_boundary" : "failed_see_receipts", runtime_verified: false,
      release_ready: false, changed_files: ["scripts/setup/packages.mjs", "scripts/setup/process.mjs", "tests/setup-package-bootstrap.test.cjs", "tests/setup-package-lifecycle.cjs", ".omo/evidence/memocap-observable-opencode-v1/packaged-lifecycle.json"] };
    evidence.finished_at = new Date().toISOString();
    write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    assert.equal(JSON.parse(fs.readFileSync(evidencePath)).finished_at, evidence.finished_at);
    console.log(JSON.stringify({ assertions: evidence.assertions, failures: evidence.failures.map(({ name, message }) => ({ name, message: message.slice(0, 1500) })), evidence: evidencePath, cleanup: evidence.cleanup }, null, 2));
    process.exitCode = evidence.failures.length ? 1 : 0;
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
