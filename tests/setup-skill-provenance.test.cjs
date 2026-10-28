"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

function manualSkill(context, version = "0.1.0") {
  const setup = fixture(context);
  setup.installCLI(version);
  const paths = setup.skillPaths(setup.project, true);
  fs.mkdirSync(path.dirname(paths.canonical), { recursive: true });
  fs.cpSync(path.join(setup.installed, "skills/memocap"), paths.canonical, { recursive: true });
  const entry = { source: "LYY/memocap", sourceType: "github", sourceUrl: "https://github.com/LYY/memocap.git",
    ref: `v${version}`, skillPath: "skills/memocap/SKILL.md" };
  const scope = { kind: "global", home: setup.home, directory: setup.project,
    config_directories: [path.dirname(setup.config)], layers: [], config: setup.config };
  const ownership = { target: "0.2.0", report: { shared_cli: { version, package_root: setup.installed } } };
  return { setup, paths, entry, scope, ownership };
}

function writeLock(legacy) {
  fs.mkdirSync(path.dirname(legacy.paths.lock), { recursive: true });
  fs.writeFileSync(legacy.paths.lock, JSON.stringify({ version: 3, skills: { memocap: legacy.entry } }));
}

function snapshot(directory) {
  return fs.readdirSync(directory).sort().map((name) => {
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    const contents = stat.isSymbolicLink() ? fs.readlinkSync(filename)
      : stat.isDirectory() ? snapshot(filename) : fs.readFileSync(filename).toString("hex");
    return [name, stat.mode, contents];
  });
}

for (const version of ["0.0.10", "0.1.0", "0.2.0"]) {
  for (const source of ["clone", "tagged tree"]) test(`adopts proven ${version} skill with ${source} provenance`, async (context) => {
    const legacy = manualSkill(context, version);
    if (source === "tagged tree") legacy.entry.sourceUrl = `https://github.com/LYY/memocap/tree/v${version}`;
    writeLock(legacy);
    const { assertSkillOwnership, discoverSkill } = await import("../scripts/setup/skills.mjs");
    const { fingerprint } = await import("../scripts/setup/files.mjs");
    const inspection = discoverSkill(legacy.scope, legacy.setup.runtime);
    const before = snapshot(legacy.setup.root);

    assertSkillOwnership(inspection, null, legacy.ownership);

    assert.deepEqual(inspection.adoption, { source: "LYY/memocap", ref: `v${version}`,
      fingerprint: fingerprint(legacy.paths.canonical) });
    assert.deepEqual(snapshot(legacy.setup.root), before);
  });
}

const rejected = [
  ["wrong repository", (legacy) => { legacy.entry.source = "other/memocap"; }],
  ["wrong source type", (legacy) => { legacy.entry.sourceType = "git"; }],
  ["wrong clone URL", (legacy) => { legacy.entry.sourceUrl = "https://github.com/other/memocap.git"; }],
  ["URL suffix", (legacy) => { legacy.entry.sourceUrl += "?ref=v0.1.0"; }],
  ["wrong tree tag", (legacy) => { legacy.entry.sourceUrl = "https://github.com/LYY/memocap/tree/v0.0.10"; }],
  ["wrong ref", (legacy) => { legacy.entry.ref = "v0.0.10"; }],
  ["branch ref", (legacy) => { legacy.entry.ref = "main"; }],
  ["untagged ref", (legacy) => { legacy.entry.ref = "0.1.0"; }],
  ["missing ref", (legacy) => { delete legacy.entry.ref; }],
  ["wrong path", (legacy) => { legacy.entry.skillPath = "other/memocap/SKILL.md"; }],
  ["empty path", (legacy) => { legacy.entry.skillPath = ""; }],
  ["modified bytes", (legacy) => { fs.appendFileSync(path.join(legacy.paths.canonical, "SKILL.md"), "user edit\n"); }],
  ["extra payload file", (legacy) => { fs.writeFileSync(path.join(legacy.paths.canonical, "extra.txt"), "user file\n"); }],
  ["unproven package", (legacy) => { legacy.ownership.report.shared_cli.package_root = null; }],
  ["missing discovery", (legacy) => { legacy.setup.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"; }],
  ["duplicate copy", (legacy) => { fs.cpSync(legacy.paths.canonical, path.join(legacy.setup.home, ".claude/skills/memocap"), { recursive: true }); }],
];

for (const source of ["clone", "tagged tree"]) {
for (const [reason, change] of rejected) test(`refuses ${reason} in ${source} without mutating manual installation`, async (context) => {
  const legacy = manualSkill(context);
  if (source === "tagged tree") legacy.entry.sourceUrl = "https://github.com/LYY/memocap/tree/v0.1.0";
  change(legacy);
  writeLock(legacy);
  const { assertSkillOwnership, discoverSkill } = await import("../scripts/setup/skills.mjs");
  const inspection = discoverSkill(legacy.scope, legacy.setup.runtime);
  const before = snapshot(legacy.setup.root);

  assert.throws(() => assertSkillOwnership(inspection, null, legacy.ownership), {
    code: reason === "duplicate copy" ? "shared_skill_migration_required" : "unowned_skill",
  });

  assert.equal(inspection.adoption, undefined);
  assert.deepEqual(snapshot(legacy.setup.root), before);
});
}

test("manual clone provenance can plan an upgrade without creating ownership state", async (context) => {
  const legacy = manualSkill(context);
  writeLock(legacy);
  const before = snapshot(legacy.setup.root);

  const report = await legacy.setup.setup(["update", "--to", "0.2.0", "--global", "--dry-run"]);

  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(fs.existsSync(report.manifest_path), false);
  assert.deepEqual(snapshot(legacy.setup.root), before);
});
