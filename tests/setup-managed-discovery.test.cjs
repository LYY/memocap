"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

for (const name of ["name: memocap # user declaration", 'name: "memo\\u0063ap"', "'name': 'memocap' # quoted YAML"]) {
  test(`local frontmatter detects a conflicting ${name}`, async (context) => {
    const f = fixture(context);
    const filename = path.join(f.home, ".agents/skills/custom/SKILL.md");
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `---\n${name}\ndescription: custom\n---\ncustom\n`);
    const before = fs.readFileSync(filename, "utf8");
    const report = await f.setup(["install", "--yes"]);
    assert.equal(report.error?.code, "unowned_skill");
    assert.equal(fs.readFileSync(filename, "utf8"), before);
    assert.equal(fs.existsSync(f.env.XDG_STATE_HOME), false);
    assert.equal(fs.existsSync(f.config), false);
    assert.equal(f.calls.some(({ args }) => args[0] === "install"), false);
  });
}

test("a memocap example in another skill body is not a discoverable memocap source", async (context) => {
  const f = fixture(context);
  const filename = path.join(f.home, ".agents/skills/custom/SKILL.md");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, "---\nname: custom\ndescription: custom\n---\n```yaml\nname: memocap\n```\n");
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.equal(report.scopes[0].skill.other_discovery.length, 1);
});

test("unsupported frontmatter name syntax refuses locally without downloading or rewriting it", async (context) => {
  const f = fixture(context);
  const filename = path.join(f.home, ".agents/skills/custom/SKILL.md");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const before = "---\nname: !!str memocap\n---\ncustom\n";
  fs.writeFileSync(filename, before);
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.error?.code, "uninspected_skill_source");
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  assert.equal(fs.existsSync(f.env.XDG_STATE_HOME), false);
  assert.equal(fs.existsSync(f.config), false);
});

for (const command of ["install", "update", "check", "doctor"]) {
  test(`remote discovery is reported as uninspected before ${command} mutates anything`, async (context) => {
    const f = fixture(context);
    fs.mkdirSync(path.dirname(f.config), { recursive: true });
    const before = JSON.stringify({ skills: { urls: ["https://skills.example.invalid/index.json"] } });
    fs.writeFileSync(f.config, before);
    const report = await f.setup([command, "--to", "0.1.0", "--yes"]);
    assert.equal(report.error?.code, "uninspected_skill_source");
    assert.equal(fs.readFileSync(f.config, "utf8"), before);
    assert.equal(fs.existsSync(f.env.XDG_STATE_HOME), false);
    assert.equal(f.calls.some(({ command, args }) => command === "npx" || args[0] === "install"), false);
  });
}

test("future worker previews do not advertise the current runner's policy as the future payload", async (context) => {
  const f = fixture(context);
  const report = await f.setup(["update", "--to", "0.2.0", "--dry-run"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.equal(report.plan.scopes[0].skill.source_status, "target_worker_required");
  assert.equal(report.plan.scopes[0].skill.path, null);
  assert.equal(report.plan.scopes[0].skill.digest, null);
  assert.equal(report.plan.scopes[0].skill.source_version, null);
  assert.equal(fs.existsSync(f.env.XDG_STATE_HOME), false);
});
