"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

test("dry-run exposes exact package and scoped skill commands without executing them", async (context) => {
  const f = fixture(context);
  const report = await f.setup(["install", "--project", f.project, "--dry-run"]);
  assert.deepEqual(report.plan?.cli.command, { executable: "npm", args: ["install", "--global", "@lyy-gh/memocap@0.1.0"] });
  assert.deepEqual(report.plan.scopes[0].skill.command, { executable: "npx", args: ["--yes", "skills@1.7.4", "add", "https://github.com/LYY/memocap/tree/v0.1.0", "--skill", "memocap", "--agent", "opencode", "--yes"], cwd: fs.realpathSync(f.project) });
  assert.equal(report.plan.scopes[0].plugin.pin, "@lyy-gh/memocap@0.1.0");
  assert.equal(report.plan.cli.scope, "current_user_shared");
  assert.equal(f.calls.some((call) => call.command === "npx"), false);
});

test("adopting an already installed exact CLI records its actual executable receipt", async (context) => {
  const f = fixture(context);
  f.installCLI("0.1.0");
  const report = await f.setup(["install", "--yes"]);
  const manifest = JSON.parse(fs.readFileSync(report.manifest_path));
  assert.equal(manifest.cli?.version, "0.1.0");
  assert.equal(manifest.cli.executable_path, f.cliPath);
  assert.equal(manifest.cli.executable_version, "0.1.0");
});

test("macOS managed preference locations are part of read-only conflict detection", async () => {
  const config = await import("../scripts/setup/config.mjs");
  const locations = config.managedConfigFiles?.({ platform: "darwin", env: {} }) || [];
  assert.equal(locations.includes("/Library/Managed Preferences/ai.opencode.managed.plist"), true);
  assert.equal(locations.includes(path.join("/Library/Managed Preferences", os.userInfo().username, "ai.opencode.managed.plist")), true);
});

test("a project symlink to external canonical contents cannot be treated as an absent skill", async (context) => {
  const f = fixture(context);
  const external = path.join(f.root, "shared skill");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "SKILL.md"), "---\nname: memocap\n---\nuser custom skill\n");
  const canonical = path.join(f.project, ".agents/skills/memocap");
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.symlinkSync(external, canonical, "dir");
  const report = await f.setup(["install", "--project", f.project, "--dry-run"]);
  assert.equal(report.error?.code, "unowned_skill");
  assert.equal(fs.readFileSync(path.join(external, "SKILL.md"), "utf8"), "---\nname: memocap\n---\nuser custom skill\n");
  assert.equal(f.calls.some((call) => call.command === "npx"), false);
});

test("check detects outdated plugin and skill even after the shared CLI reached the target", async (context) => {
  const f = fixture(context);
  const metadata = path.join(f.packageRoot, "package.json");
  fs.writeFileSync(metadata, JSON.stringify({ name: "@lyy-gh/memocap", version: "0.0.10" }));
  await f.setup(["install", "--yes"]);
  fs.writeFileSync(metadata, JSON.stringify({ name: "@lyy-gh/memocap", version: "0.1.0" }));
  f.installCLI("0.1.0");
  const report = await f.setup(["check", "--to", "0.1.0"]);
  assert.equal(report.exit_code, 0);
  assert.equal(report.update_available, true);
  assert.equal(report.repair_required, true);
});
