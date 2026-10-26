"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

function managedFixture(context) {
  const f = fixture(context);
  fs.mkdirSync(path.join(f.packageRoot, "skills/memocap/references"));
  fs.writeFileSync(path.join(f.packageRoot, "skills/memocap/references/contract.md"), "full reference bytes\r\n");
  const run = f.runtime.run;
  f.runtime.run = (command, args, options) => {
    assert.equal(command === "git" || (command === "npx" && args.includes("skills@1.7.4")), false, "no skills CLI or skill Git prerequisite");
    return run(command, args, options);
  };
  return f;
}

function tree(directory) {
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory).sort().map((name) => {
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    return [name, stat.mode, stat.isSymbolicLink() ? fs.readlinkSync(filename) : stat.isDirectory() ? tree(filename) : fs.readFileSync(filename).toString("hex")];
  });
}

test("managed install copies the complete bundle and registers one absolute shared directory", async (context) => {
  const f = managedFixture(context);
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  const config = JSON.parse(fs.readFileSync(f.config));
  const directory = config.plugin[0][1].skillDirectory;
  assert.deepEqual(config.skills.paths, [directory]);
  assert.equal(path.isAbsolute(directory), true);
  assert.deepEqual(tree(directory), tree(path.join(f.packageRoot, "skills/memocap")));
  assert.equal(fs.existsSync(f.skillPaths(f.project, true).canonical), false);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const installed = JSON.parse(fs.readFileSync(report.manifest_path)).installs[report.scopes[0].id].skill;
  assert.equal(installed.digest, inspectPolicy(directory).digest);
  assert.equal(installed.kind, "managed");
  const before = tree(f.home);
  assert.equal((await f.setup(["install", "--yes"])).status, "unchanged");
  assert.deepEqual(tree(f.home), before);
});

test("copy failure leaves the old configuration unexposed and same-target retry reads actual CLI", async (context) => {
  const f = managedFixture(context);
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, "{}\r\n");
  const copy = fs.cpSync;
  context.mock.method(fs, "cpSync", (source, destination, options) => {
    if (String(destination).includes(".memocap-policy-")) { fs.mkdirSync(destination); throw Object.assign(new Error("partial copy"), { code: "EACCES" }); }
    return copy(source, destination, options);
  });
  const failed = await f.setup(["install", "--yes"]);
  context.mock.restoreAll();
  assert.equal(failed.exit_code, 1);
  assert.equal(fs.readFileSync(f.config, "utf8"), "{}\r\n");
  f.calls.length = 0;
  assert.equal((await f.setup(["install", "--yes"])).exit_code, 0);
  assert.equal(f.calls.some((call) => call.args[0] === "install"), false);
});

test("config commit followed by manifest failure resumes from persisted ownership intent", async (context) => {
  const f = managedFixture(context);
  const rename = fs.renameSync;
  let committed = false;
  let failed = false;
  context.mock.method(fs, "renameSync", (source, destination) => {
    if (committed && !failed && String(destination).endsWith("/memocap/setup.json")) { failed = true; throw Object.assign(new Error("manifest fault"), { code: "EACCES" }); }
    const outcome = rename(source, destination);
    if (destination === f.config) committed = true;
    return outcome;
  });
  const partial = await f.setup(["install", "--yes"]);
  context.mock.restoreAll();
  assert.equal(partial.error.code, "manifest_write_failed");
  const bytes = fs.readFileSync(f.config, "utf8");
  const recovered = await f.setup(["install", "--yes"]);
  assert.equal(recovered.exit_code, 0, JSON.stringify(recovered));
  assert.equal(fs.readFileSync(f.config, "utf8"), bytes);
  assert.equal(JSON.parse(fs.readFileSync(recovered.manifest_path)).installs[recovered.scopes[0].id].intent, undefined);
});

test("project inherits the exact global owner without another tuple path or record", async (context) => {
  const f = managedFixture(context);
  const global = await f.setup(["install", "--yes"]);
  const before = tree(f.home);
  const project = await f.setup(["install", "--project", f.project, "--yes"]);
  assert.equal(project.exit_code, 0, JSON.stringify(project));
  assert.equal(project.scopes[0].owner_id, global.scopes[0].id);
  assert.equal(project.scopes[0].owner_reused, true);
  assert.equal(fs.existsSync(path.join(f.project, "opencode.jsonc")), false);
  assert.deepEqual(tree(f.home), before);
  assert.equal((await f.setup(["uninstall", "--project", f.project, "--yes"])).exit_code, 0);
  assert.deepEqual(tree(f.home), before);
});

for (const fault of ["layer", "alias", "reference", "arbitrary-config", "payload"]) test(`preflight preserves every byte for ${fault} conflict`, async (context) => {
  const f = managedFixture(context);
  const installed = await f.setup(["install", "--yes"]);
  const config = JSON.parse(fs.readFileSync(f.config));
  const directory = config.plugin[0][1].skillDirectory;
  const args = ["update", "--to", "0.1.0", "--yes"];
  if (fault === "layer") fs.writeFileSync(path.join(f.project, "opencode.json"), JSON.stringify({ plugin: [config.plugin[0]] }));
  if (fault === "alias") { const alias = path.join(f.home, ".agents/skills/memocap"); fs.mkdirSync(path.dirname(alias), { recursive: true }); fs.symlinkSync(directory, alias, "dir"); }
  if (fault === "reference") { config.skills.paths.push(directory); fs.writeFileSync(f.config, JSON.stringify(config)); }
  if (fault === "arbitrary-config") args.push("--config", path.join(f.root, "unused.jsonc"));
  if (fault === "payload") fs.appendFileSync(path.join(directory, "references/contract.md"), "changed");
  f.calls.length = 0;
  const before = tree(f.root);
  const report = await f.setup(args);
  assert.equal(report.exit_code, 1, JSON.stringify(report));
  assert.deepEqual(tree(f.root), before);
  assert.equal(f.calls.some((call) => ["install", "add", "remove", "uninstall"].includes(call.args[0])), false);
  assert.equal(fs.existsSync(`${installed.manifest_path}.lock`), false);
});

test("uninstall retains modified payload and preserves memory and backup sentinels", async (context) => {
  const f = managedFixture(context);
  const installed = await f.setup(["install", "--yes"]);
  const directory = installed.scopes[0].skill.installed.path;
  fs.appendFileSync(path.join(directory, "references/contract.md"), "user change");
  const database = path.join(f.home, ".memocap/memocap.db");
  fs.writeFileSync(database, "user memory");
  fs.writeFileSync(`${database}.backup`, "user backup");
  const report = await f.setup(["uninstall", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(report.warnings.some((warning) => warning.code === "skill_modified"), true);
  assert.equal(fs.existsSync(directory), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config)).skills.paths, []);
  assert.equal(fs.readFileSync(database, "utf8"), "user memory");
  assert.equal(fs.readFileSync(`${database}.backup`, "utf8"), "user backup");
});

test("managed inspection stays visible with external discovery disabled and read-only commands do not write", async (context) => {
  const f = managedFixture(context);
  assert.equal((await f.setup(["install", "--yes"])).exit_code, 0);
  f.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
  const before = tree(f.root);
  for (const args of [["check", "--to", "0.1.0"], ["doctor"], ["update", "--to", "0.1.0", "--dry-run"]]) {
    const report = await f.setup(args);
    assert.equal(report.scopes[0].skill.status, "discovered", JSON.stringify(report));
    assert.equal(report.scopes[0].skill.plugin_expected_path, report.scopes[0].skill.host_expected_path);
    assert.deepEqual(tree(f.root), before);
  }
});

module.exports = { managedFixture, tree };
