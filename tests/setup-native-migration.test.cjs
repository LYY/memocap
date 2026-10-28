"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

function snapshot(directory) {
  return fs.readdirSync(directory).sort().map((name) => {
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    return [name, stat.mode, stat.isSymbolicLink() ? fs.readlinkSync(filename) : stat.isDirectory() ? snapshot(filename) : fs.readFileSync(filename).toString("hex")];
  });
}

async function legacyFixture(context, present = true) {
  const f = fixture(context);
  fs.writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.2.1" }));
  f.installCLI("0.2.1");
  const paths = f.skillPaths(f.project, true);
  fs.mkdirSync(paths.canonical, { recursive: true });
  fs.cpSync(path.join(f.installed, "skills/memocap"), paths.canonical, { recursive: true });
  const { fingerprint } = await import("../scripts/setup/files.mjs");
  const proof = fingerprint(paths.canonical);
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ version: 3, skills: { memocap: { source: "LYY/memocap", sourceType: "github", ref: "v0.2.1", sourceUrl: "https://github.com/LYY/memocap/tree/v0.2.1" }, other: { source: "keep" } } }));
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, '{/* user */"plugin":[["@lyy-gh/memocap@0.2.1",{"automatic":false}]],"model":"keep"}');
  const manifest = path.join(f.env.XDG_STATE_HOME, "memocap/setup.json");
  const id = `global:${f.config}`;
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ format_version: 1, installs: { [id]: { kind: "global", directory: f.project, config: f.config, version: "0.2.1", steps: {}, plugin: { entry: ["@lyy-gh/memocap@0.2.1", { automatic: false }] }, skill: { path: paths.canonical, discovery_path: paths.canonical, version: "0.2.1", fingerprint: proof, source: "https://github.com/LYY/memocap/tree/v0.2.1", agents: ["OpenCode"] } } } }, null, 3));
  if (!present) fs.rmSync(paths.canonical, { recursive: true });
  return { ...f, paths, manifest, id };
}

test("real format-1 0.2.1 missing canonical migrates without restoring canonical or old locks", async (context) => {
  const f = await legacyFixture(context, false);
  const lock = fs.readFileSync(f.paths.lock, "utf8");
  const report = await f.setup(["update", "--to", "0.2.1", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(fs.existsSync(f.paths.canonical), false);
  assert.equal(fs.readFileSync(f.paths.lock, "utf8"), lock);
  const record = JSON.parse(fs.readFileSync(f.manifest)).installs[f.id];
  assert.equal(record.skill.kind, "managed");
  assert.equal(record.migration.legacy_state, "missing");
  assert.equal(JSON.parse(fs.readFileSync(f.manifest)).format_version, 2);
});

test("proven exclusive legacy is cleaned once and unrelated lock metadata survives", async (context) => {
  const f = await legacyFixture(context);
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(fs.existsSync(f.paths.canonical), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.lock)).skills, { other: { source: "keep" } });
  assert.equal(report.steps.find((step) => step.component === "legacy_cleanup").status, "changed");
});

for (const command of ["install", "update", "check", "doctor"]) test(`35 shared aliases block ${command} even at the same version before all writes`, async (context) => {
  const f = await legacyFixture(context);
  for (let index = 0; index < 35; index++) {
    const alias = path.join(f.home, `.agent-${index}/skills/memocap`);
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(f.paths.canonical, alias, "dir");
  }
  const before = snapshot(f.root);
  f.calls.length = 0;
  const report = await f.setup([command, "--to", "0.2.1", "--yes"]);
  assert.equal(report.error?.code, "shared_skill_migration_required", JSON.stringify(report));
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(f.calls.some((call) => call.command === "npx" || ["install", "add"].includes(call.args[0])), false);
});

for (const command of ["check", "doctor", "update"]) test(`known format-1 ${command} inspection preserves exact bytes`, async (context) => {
  const f = await legacyFixture(context, false);
  const before = snapshot(f.root);
  const report = await f.setup([command, "--to", "0.2.1", ...(command === "update" ? ["--dry-run"] : [])]);
  assert.equal(report.migration_required, true);
  assert.deepEqual(snapshot(f.root), before);
});

module.exports = { legacyFixture, snapshot };

test("legacy cleanup followed by an interrupted config CAS resumes without restoring canonical", async (context) => {
  const f = await legacyFixture(context);
  const rename = fs.renameSync;
  context.mock.method(fs, "renameSync", (source, destination) => {
    if (destination === f.config) throw Object.assign(new Error("switch interrupted"), { code: "EACCES" });
    return rename(source, destination);
  });
  const partial = await f.setup(["update", "--to", "0.2.1", "--yes"]);
  context.mock.restoreAll();
  assert.equal(partial.error.code, "EACCES");
  assert.equal(fs.existsSync(f.paths.canonical), false);
  const lock = fs.readFileSync(f.paths.lock, "utf8");
  const recovered = await f.setup(["update", "--to", "0.2.1", "--yes"]);
  assert.equal(recovered.exit_code, 0, JSON.stringify(recovered.error));
  assert.equal(fs.existsSync(f.paths.canonical), false);
  assert.equal(fs.readFileSync(f.paths.lock, "utf8"), lock);
});

test("a concurrent legacy lock change prevents deleting canonical contents", async (context) => {
  const f = await legacyFixture(context);
  let changed = false;
  f.state.afterCommand = (command, args) => {
    if (!changed && path.isAbsolute(command) && args[0] === "--version" && JSON.parse(fs.readFileSync(f.manifest)).installs[f.id].intent) {
      changed = true;
      const lock = JSON.parse(fs.readFileSync(f.paths.lock));
      lock.user_marker = "preserve";
      fs.writeFileSync(f.paths.lock, JSON.stringify(lock));
    }
  };
  const before = snapshot(f.paths.canonical);
  const refused = await f.setup(["update", "--to", "0.2.1", "--yes"]);
  assert.equal(refused.error.code, "concurrent_change");
  assert.equal(fs.existsSync(f.paths.canonical), true);
  assert.deepEqual(snapshot(f.paths.canonical), before);
  assert.equal(JSON.parse(fs.readFileSync(f.paths.lock)).user_marker, "preserve");
});
