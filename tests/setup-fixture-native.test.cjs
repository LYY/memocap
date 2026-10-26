"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");
const { snapshot } = require("./packaged-runtime.cjs");

test("shared Windows host fixture has package metadata and a usable explicit cmd target", async (context) => {
  const { inspectHost, verifyHost } = await import("../scripts/setup/host.mjs");
  const { launcherScript } = await import("../scripts/setup/process.mjs");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const setup = fixture(context);
    const before = snapshot([setup.root]);
    const host = inspectHost(setup.runtime);
    assert.equal(host.version, "1.19.3");
    assert.equal(host.source, fs.realpathSync(path.join(setup.root, "host/package.json")));
    assert.equal(setup.calls.length, 0);
    assert.ok(fs.statSync(launcherScript(host.executable_path)).isFile());
    assert.equal(await verifyHost(setup.runtime, { ...host, version: null }), "1.19.3");
    assert.deepEqual(snapshot([setup.root]), before);
  } finally { Object.defineProperty(process, "platform", platform); }
});

for (const scope of ["global", "project"]) {
  test(`native ${scope} setup copies its policy within the selected filesystem root`, async (context) => {
    const f = fixture(context);
    const root = scope === "global" ? path.join(fs.realpathSync(f.home), "config/opencode") : path.join(fs.realpathSync(f.project), ".opencode");
    const args = scope === "global" ? ["--global"] : ["--project", f.project];

    const report = await f.setup(["install", ...args, "--yes"]);

    assert.equal(report.exit_code, 0, JSON.stringify(report.error));
    assert.equal(report.prerequisites.platform, `${process.platform}/${process.arch}`);
    const directory = report.scopes[0].skill.installed.path;
    const relative = path.relative(root, directory);
    assert.equal(path.isAbsolute(relative), false, relative);
    assert.equal(relative.split(path.sep).includes(".."), false, relative);
    assert.deepEqual(fs.readFileSync(path.join(directory, "SKILL.md")), fs.readFileSync(path.join(f.packageRoot, "skills/memocap/SKILL.md")));
    const config = JSON.parse(fs.readFileSync(report.scopes[0].config, "utf8"));
    assert.equal(config.plugin[0][1].skillDirectory, directory);
    assert.deepEqual(config.skills.paths, [directory]);
  });
}
