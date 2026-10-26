"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

function runtime(context) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memocap manifest "));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { env: { HOME: home, XDG_STATE_HOME: home }, platform: process.platform };
}

test("missing manifest defaults to format 2 without creating state", async (context) => {
  const scope = runtime(context);
  const { loadManifest } = await import("../scripts/setup/manifest.mjs");
  const loaded = loadManifest(scope);
  assert.deepEqual(loaded.manifest, { format_version: 2, installs: {} });
  assert.equal(loaded.text, null);
  assert.deepEqual(fs.readdirSync(scope.env.HOME), []);
});

for (const version of [1, 2]) {
  test(`known manifest format ${version} reads retain exact bytes and legacy ownership proof`, async (context) => {
    const scope = runtime(context);
    const { manifestLocation, loadManifest } = await import("../scripts/setup/manifest.mjs");
    const filename = manifestLocation(scope);
    const legacy = { skill: { path: "/legacy", version: "0.2.1", fingerprint: "old-proof" }, plugin: { entry: ["@lyy-gh/memocap@0.2.1", { custom: true }] } };
    const text = ` { "format_version": ${version}, "installs": ${JSON.stringify({ "global:fixture": legacy })} }\r\n`;
    fs.mkdirSync(path.dirname(filename));
    fs.writeFileSync(filename, text);
    const loaded = loadManifest(scope);
    assert.deepEqual(loaded.manifest.installs["global:fixture"], legacy);
    assert.equal(loaded.manifest.format_version, version);
    assert.equal(fs.readFileSync(filename, "utf8"), text);
    assert.deepEqual(fs.readdirSync(path.dirname(filename)), ["setup.json"]);
  });
}

for (const malformed of [{ format_version: 3, installs: {} }, { format_version: "2", installs: {} }, { format_version: 2, installs: [] }, { format_version: 2, installs: null }, { format_version: 2, installs: { bad: null } }, null, []]) {
  test("unknown or malformed manifests refuse without rewriting bytes", async (context) => {
    const scope = runtime(context);
    const { manifestLocation, loadManifest } = await import("../scripts/setup/manifest.mjs");
    const filename = manifestLocation(scope);
    const text = `${JSON.stringify(malformed)}\n`;
    fs.mkdirSync(path.dirname(filename));
    fs.writeFileSync(filename, text);
    assert.throws(() => loadManifest(scope), { code: "manifest_version" });
    assert.equal(fs.readFileSync(filename, "utf8"), text);
  });
}

test("format upgrade requires the acquired manifest lock and preserves prior records", async (context) => {
  const scope = runtime(context);
  const { manifestLocation, loadManifest, lockManifest, upgradeManifest } = await import("../scripts/setup/manifest.mjs");
  const filename = manifestLocation(scope);
  const legacy = { skill: { path: "/legacy", fingerprint: "old-proof", version: "0.2.1" } };
  fs.mkdirSync(path.dirname(filename));
  const text = JSON.stringify({ format_version: 1, installs: { legacy } });
  fs.writeFileSync(filename, text);
  const state = { manifestPath: filename, manifestText: text, manifest: loadManifest(scope).manifest, report: { backups: [], steps: [] } };
  assert.throws(() => upgradeManifest(state), { code: "manifest_lock_required" });
  const unlock = lockManifest(state);
  try {
    assert.equal(upgradeManifest(state).status, "changed");
    assert.equal(upgradeManifest(state).status, "unchanged");
  } finally { unlock(); }
  const saved = loadManifest(scope).manifest;
  assert.equal(saved.format_version, 2);
  assert.deepEqual(saved.installs.legacy, legacy);
  assert.equal(saved.installs.legacy.skill.kind, undefined);
  assert.equal(state.report.backups.length, 1);
  assert.throws(() => upgradeManifest(state), { code: "manifest_lock_required" });
});

for (const command of ["check", "doctor"]) {
  test(`${command} reads an existing format-1 install without changing manifest bytes`, async (context) => {
    const setup = fixture(context);
    const installed = await setup.setup(["install", "--yes"]);
    const manifest = JSON.parse(fs.readFileSync(installed.manifest_path));
    manifest.format_version = 1;
    const bytes = ` ${JSON.stringify(manifest)}\r\n`;
    fs.writeFileSync(installed.manifest_path, bytes);
    const report = await setup.setup([command]);
    assert.equal(report.error, null);
    assert.equal(fs.readFileSync(installed.manifest_path, "utf8"), bytes);
  });
}

test("unknown manifest produces a nonzero setup receipt before any mutator", async (context) => {
  const setup = fixture(context);
  const { manifestLocation } = await import("../scripts/setup/manifest.mjs");
  const filename = manifestLocation(setup.runtime);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const bytes = '{"format_version":99,"installs":{}}\r\n';
  fs.writeFileSync(filename, bytes);
  const report = await setup.setup(["doctor"]);
  assert.equal(report.exit_code, 1);
  assert.equal(report.error.code, "manifest_version");
  assert.equal(fs.readFileSync(filename, "utf8"), bytes);
  assert.equal(setup.calls.some((call) => call.command === "npx" || ["install", "add", "remove", "uninstall"].includes(call.args[0])), false);
});

test("explicit upgrade preserves a concurrent edit and keeps the loaded format on failure", async (context) => {
  const scope = runtime(context);
  const { manifestLocation, loadManifest, lockManifest, upgradeManifest } = await import("../scripts/setup/manifest.mjs");
  const filename = manifestLocation(scope);
  fs.mkdirSync(path.dirname(filename));
  const text = '{"format_version":1,"installs":{}}';
  fs.writeFileSync(filename, text);
  const state = { manifestPath: filename, manifestText: text, manifest: loadManifest(scope).manifest, report: { backups: [], steps: [] } };
  const unlock = lockManifest(state);
  const concurrent = '{"format_version":1,"installs":{"another":{"version":"0.2.1"}}}';
  fs.writeFileSync(filename, concurrent);
  try { assert.throws(() => upgradeManifest(state), { code: "manifest_write_failed" }); }
  finally { unlock(); }
  assert.equal(fs.readFileSync(filename, "utf8"), concurrent);
  assert.equal(state.manifest.format_version, 1);
  assert.equal(state.report.steps.at(-1).status, "failed");
});
