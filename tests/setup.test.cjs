"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const fs = require("node:fs");
const { fixture } = require("./setup-fixtures.cjs");

test("setup exposes help without starting package or host processes", () => {
  const execution = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/setup.mjs"), "--help", "--json"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout).commands, ["install", "check", "update", "doctor", "uninstall"]);
});

test("install preserves JSONC comments, options and unrelated plugins then repeats without writes", async (context) => {
  const f = fixture(context);
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, '{\n // keep comment\n "plugin": [["other@1", {"enabled": true}]],\n "model": "local/test",\n}\n');
  const first = await f.setup(["install", "--yes", "--json"]);
  assert.equal(first.exit_code, 0, JSON.stringify(first));
  const text = fs.readFileSync(f.config, "utf8");
  const { parse } = await import("jsonc-parser");
  assert.equal(text.includes("// keep comment"), true);
  assert.deepEqual(parse(text).plugin, [["other@1", { enabled: true }], "@lyy-gh/memocap@0.1.0"]);
  assert.equal(first.runtime.status, "not_run");
  assert.equal(first.scopes[0].plugin.status, "configured");
  assert.deepEqual(first.scopes[0].plugin.entries, ["@lyy-gh/memocap@0.1.0"]);
  assert.equal(first.restart_required, true);
  f.calls.length = 0;
  const repeat = await f.setup(["install", "--yes", "--json"]);
  assert.equal(repeat.exit_code, 0, JSON.stringify(repeat));
  assert.equal(repeat.status, "unchanged");
  assert.equal(f.calls.some((call) => call.args.includes("add") || call.args.includes("install")), false);
  assert.equal(fs.readFileSync(f.config, "utf8"), text);
});

test("dry-run does not download, warm binaries, or create config, skills, manifests or DB", async (context) => {
  const f = fixture(context);
  const report = await f.setup(["install", "--dry-run", "--json"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(fs.existsSync(f.config), false);
  assert.equal(fs.existsSync(path.join(f.home, "state")), false);
  assert.equal(fs.existsSync(path.join(f.home, ".agents")), false);
  assert.equal(f.calls.some((call) => call.command === "npx" || call.command.endsWith("/memocap")), false);
});

test("custom config and project selection preserve explicit scope and report precedence", async (context) => {
  const f = fixture(context);
  f.env.OPENCODE_CONFIG = path.join(f.home, "custom file.jsonc");
  f.env.OPENCODE_CONFIG_DIR = path.join(f.home, "higher config");
  const explicit = path.join(f.project, "custom.jsonc");
  const report = await f.setup(["install", "--project", f.project, "--config", explicit, "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(fs.existsSync(explicit), true);
  assert.equal(fs.existsSync(f.config), false);
  assert.equal(report.scopes[0].config, explicit);
  assert.equal(report.scopes[0].higher_precedence.includes(path.join(f.env.OPENCODE_CONFIG_DIR, "opencode.jsonc")), true);
  assert.equal(report.shared_cli.scope, "current_user");
});

for (const conflict of ["memory", "content", "local-plugin"]) {
  test(`install refuses ${conflict} conflict before installing CLI`, async (context) => {
    const f = fixture(context);
    fs.mkdirSync(path.dirname(f.config), { recursive: true });
    const contents = conflict === "memory" ? { command: { memory: { template: "user command" } } }
      : conflict === "local-plugin" ? { plugin: ["file:///custom/memocap.js"] } : {};
    fs.writeFileSync(f.config, JSON.stringify(contents));
    if (conflict === "content") f.env.OPENCODE_CONFIG_CONTENT = '{"plugin": []}';
    const report = await f.setup(["install", "--yes"]);
    assert.equal(report.exit_code > 0, true);
    assert.equal(f.calls.some((call) => call.args.includes("install")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.config)), contents);
  });
}

test("partial skill failure resumes from CLI and plugin readback without repeating package install", async (context) => {
  const f = fixture(context);
  f.state.fail = (command, args) => command === "npx" && args.includes("add");
  const partial = await f.setup(["install", "--yes"]);
  assert.equal(partial.status, "partial");
  assert.equal(partial.steps.some((step) => step.component === "plugin" && step.status === "changed"), true);
  f.state.fail = null;
  f.calls.length = 0;
  const recovered = await f.setup(["install", "--yes"]);
  assert.equal(recovered.exit_code, 0, JSON.stringify(recovered));
  assert.equal(f.calls.some((call) => call.command === "npm" && call.args[0] === "install"), false);
});

test("uninstall preserves DB and unrelated user config", async (context) => {
  const f = fixture(context);
  await f.setup(["install", "--yes"]);
  const database = path.join(f.home, ".memocap/memocap.db");
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.writeFileSync(database, "preserve core DB bytes");
  const { modify, applyEdits, parse } = await import("jsonc-parser");
  fs.writeFileSync(f.config, applyEdits(fs.readFileSync(f.config, "utf8"), modify(fs.readFileSync(f.config, "utf8"), ["model"], "user/new", {})));
  const report = await f.setup(["uninstall", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  assert.equal(parse(fs.readFileSync(f.config, "utf8")).model, "user/new");
  assert.deepEqual(parse(fs.readFileSync(f.config, "utf8")).plugin, []);
  assert.equal(fs.readFileSync(database, "utf8"), "preserve core DB bytes");
  assert.equal(fs.existsSync(path.join(f.prefix, "bin/memocap")), true);
});
