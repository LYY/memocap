"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

test("shared managed payload survives the first owner and is removed after the last reference", async (context) => {
  const f = fixture(context);
  const first = await f.setup(["install", "--project", f.project, "--yes"]);
  assert.equal(first.exit_code, 0, JSON.stringify(first.error));
  const second = path.join(f.root, "other project");
  fs.mkdirSync(second);
  const config = path.join(second, "opencode.jsonc");
  fs.copyFileSync(first.scopes[0].config, config);
  const manifest = JSON.parse(fs.readFileSync(first.manifest_path));
  const id = `project:${fs.realpathSync(second)}`;
  manifest.installs[id] = { ...structuredClone(manifest.installs[first.scopes[0].id]), directory: fs.realpathSync(second), config };
  fs.writeFileSync(first.manifest_path, JSON.stringify(manifest));
  const payload = first.scopes[0].skill.installed.path;
  const removedFirst = await f.setup(["uninstall", "--project", f.project, "--yes"]);
  assert.equal(removedFirst.exit_code, 0, JSON.stringify(removedFirst.error));
  assert.equal(fs.existsSync(payload), true);
  const removedLast = await f.setup(["uninstall", "--project", second, "--yes"]);
  assert.equal(removedLast.exit_code, 0, JSON.stringify(removedLast.error));
  assert.equal(fs.existsSync(payload), false);
});

test("an inherited global version mismatch stops before any filesystem mutation", async (context) => {
  const f = fixture(context);
  assert.equal((await f.setup(["install", "--yes"])).exit_code, 0);
  fs.writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.2.0" }));
  const snapshot = () => fs.readdirSync(f.home, { recursive: true }).sort().map((name) => [name, fs.statSync(path.join(f.home, name)).isFile() ? fs.readFileSync(path.join(f.home, name)).toString("hex") : null]);
  const before = snapshot();
  const refused = await f.setup(["install", "--project", f.project, "--yes"]);
  assert.equal(refused.error.code, "plugin_layer_conflict");
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.existsSync(path.join(f.project, "opencode.jsonc")), false);
});

test("project reuse repairs the shared CLI without creating project ownership", async (context) => {
  const f = fixture(context);
  const global = await f.setup(["install", "--yes"]);
  assert.equal(global.exit_code, 0);
  f.installCLI("0.0.10");
  const repaired = await f.setup(["install", "--project", f.project, "--yes"]);
  assert.equal(repaired.exit_code, 0, JSON.stringify(repaired.error));
  assert.equal(repaired.shared_cli.executable_version, "0.1.0");
  assert.equal(repaired.scopes[0].owner_reused, true);
  assert.equal(fs.existsSync(path.join(f.project, "opencode.jsonc")), false);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(global.manifest_path)).installs).length, 1);
});

test("removing CLI through an inherited project refuses to remove its global dependency", async (context) => {
  const f = fixture(context);
  assert.equal((await f.setup(["install", "--yes"])).exit_code, 0);
  const report = await f.setup(["uninstall", "--project", f.project, "--remove-cli", "--yes"]);
  assert.equal(report.error?.code, "cli_references_remain");
  assert.equal(fs.existsSync(f.managedPath()), true);
  assert.equal(fs.existsSync(f.cliPath), true);
});

for (const options of [null, [], { extra: true }]) for (const command of ["install", "update", "check", "doctor"]) {
  test(`invalid owned tuple preflight ${command}/${JSON.stringify(options)}`, async (context) => {
    const f = fixture(context);
    f.installCLI("0.1.0");
    fs.mkdirSync(path.dirname(f.config), { recursive: true });
    const tuple = ["@lyy-gh/memocap@0.1.0", options];
    if (options?.extra) tuple.push("unowned third element");
    const text = JSON.stringify({ plugin: [tuple] });
    fs.writeFileSync(f.config, text);
    f.calls.length = 0;
    const report = await f.setup([command, "--to", "0.1.0", "--yes"]);
    assert.equal(report.error?.code, "invalid_plugin_config");
    assert.equal(fs.readFileSync(f.config, "utf8"), text);
    assert.equal(fs.existsSync(f.env.XDG_STATE_HOME), false);
    assert.equal(fs.existsSync(path.join(path.dirname(f.config), "memocap")), false);
    assert.equal(f.calls.some(({ args }) => args[0] === "install"), false);
  });
}
