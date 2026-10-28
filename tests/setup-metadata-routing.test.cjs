"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

for (const boundary of ["bundle", "staging", "final"]) {
  for (const failure of ["reparse", "throw"]) {
    test(`${boundary} metadata ${failure} refuses publication and preserves config bytes`, async (context) => {
      const f = fixture(context);
      const source = path.join(f.packageRoot, "skills/memocap");
      const sourceBytes = fs.readFileSync(path.join(source, "SKILL.md"));
      const configBytes = Buffer.from('{"model":"protected"}\n');
      fs.mkdirSync(path.dirname(f.config), { recursive: true });
      fs.writeFileSync(f.config, configBytes);
      const refused = [];
      const injected = new Error(`routing-${boundary}-${failure}`);
      f.runtime.policyMetadata = (directory) => {
        const selected = boundary === "bundle" ? directory === source
          : boundary === "staging" ? directory.includes(`${path.sep}.memocap-policy-`)
            : directory !== source && !directory.includes(`${path.sep}.memocap-policy-`);
        if (!selected) return null;
        refused.push(directory);
        if (failure === "throw") throw injected;
        return path.join(directory, "SKILL.md");
      };

      const report = await f.setup(["install", "--yes"]);

      assert.ok(refused.length > 0, "the injected refusal must actually run");
      assert.equal(report.exit_code, 1);
      assert.equal(report.error.code, failure === "throw" ? "policy_reparse_check_failed" : "policy_file_type");
      if (failure === "throw") assert.ok(report.error.message.includes(injected.message));
      assert.deepEqual(fs.readFileSync(f.config), configBytes);
      assert.deepEqual(fs.readFileSync(path.join(source, "SKILL.md")), sourceBytes);
      if (boundary === "bundle") {
        assert.equal(report.status, "failed");
        assert.equal(fs.existsSync(path.join(f.env.XDG_STATE_HOME, "memocap/setup.json")), false);
        assert.equal(f.calls.some((call) => call.args[0] === "install"), false);
      }
      if (boundary === "final") assert.deepEqual(fs.readFileSync(path.join(refused[0], "SKILL.md")), sourceBytes);
      const names = fs.readdirSync(f.root, { recursive: true });
      assert.equal(names.some((name) => path.basename(name).startsWith(".memocap-policy-")), false);
    });
  }
}

for (const failure of ["reparse", "throw"]) {
  test(`managed discovery ${failure} preserves installed config, manifest and payload`, async (context) => {
    const f = fixture(context);
    f.runtime.policyMetadata = () => null;
    const installed = await f.setup(["install", "--yes"]);
    assert.equal(installed.exit_code, 0, JSON.stringify(installed));
    const directory = f.managedPath();
    const protectedPaths = [f.config, installed.manifest_path, path.join(directory, "SKILL.md")];
    const protectedBytes = protectedPaths.map((filename) => fs.readFileSync(filename));
    const refused = [];
    const injected = new Error(`routing-discovery-${failure}`);
    f.runtime.policyMetadata = (scanned) => {
      if (scanned !== directory) return null;
      refused.push(scanned);
      if (failure === "throw") throw injected;
      return path.join(scanned, "SKILL.md");
    };

    const report = await f.setup(["update", "--to", "0.1.0", "--yes"]);

    assert.ok(refused.length > 0, "managed discovery must consult this runtime");
    assert.equal(report.error.code, "skill_modified");
    assert.equal(report.error.details.code, failure === "throw" ? "policy_reparse_check_failed" : "policy_file_type");
    if (failure === "throw") assert.ok(report.error.details.message.includes(injected.message));
    protectedPaths.forEach((filename, index) => { assert.deepEqual(fs.readFileSync(filename), protectedBytes[index]); });
  });

  test(`target fallback ${failure} propagates its own metadata refusal`, async (context) => {
    const f = fixture(context);
    const { configScopes } = await import("../scripts/setup/config.mjs");
    const { parseArguments } = await import("../scripts/setup/arguments.mjs");
    const { targetPolicy } = await import("../scripts/setup/skills.mjs");
    const scope = configScopes(parseArguments(["install", "--global"], f.runtime.cwd), f.runtime)[0];
    const source = path.join(f.packageRoot, "skills/memocap");
    const bytes = fs.readFileSync(path.join(source, "SKILL.md"));
    const inspected = [];
    const injected = new Error(`routing-fallback-${failure}`);
    f.runtime.policyMetadata = (directory) => {
      inspected.push(directory);
      if (failure === "throw") throw injected;
      return path.join(directory, "SKILL.md");
    };

    assert.throws(() => targetPolicy(scope, { runtime: f.runtime, target: "0.1.0", report: { runner_version: "0.1.0" } }),
      (error) => error.code === (failure === "throw" ? "policy_reparse_check_failed" : "policy_file_type") && (failure !== "throw" || error.cause === injected));

    assert.deepEqual(inspected, [source]);
    assert.deepEqual(fs.readFileSync(path.join(source, "SKILL.md")), bytes);
    assert.equal(fs.existsSync(f.config), false);
  });

  test(`pre-removal ${failure} preserves bytes after registration removal`, async (context) => {
    const f = fixture(context);
    f.runtime.policyMetadata = () => null;
    assert.equal((await f.setup(["install", "--yes"])).exit_code, 0);
    const directory = f.managedPath();
    const filename = path.join(directory, "SKILL.md");
    const bytes = fs.readFileSync(filename);
    const refused = [];
    const injected = new Error(`routing-removal-${failure}`);
    f.runtime.policyMetadata = (scanned) => {
      if (scanned !== directory || (JSON.parse(fs.readFileSync(f.config)).plugin || []).length) return null;
      refused.push(scanned);
      if (failure === "throw") throw injected;
      return filename;
    };

    const report = await f.setup(["uninstall", "--yes"]);

    assert.ok(refused.length > 0, "the pre-removal callback must run after config removal");
    assert.equal(report.exit_code, 0, JSON.stringify(report));
    assert.equal(report.steps.find((step) => step.component === "skill_removal").status, "retained_modified");
    assert.ok(report.warnings.some((warning) => warning.code === "skill_modified"));
    assert.deepEqual(fs.readFileSync(filename), bytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.config)).plugin || [], []);
  });
}

test("target fallback uses successful metadata while deriving the actual content digest", async (context) => {
  const f = fixture(context);
  const { configScopes } = await import("../scripts/setup/config.mjs");
  const { parseArguments } = await import("../scripts/setup/arguments.mjs");
  const { targetPolicy } = await import("../scripts/setup/skills.mjs");
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const source = path.join(f.packageRoot, "skills/memocap");
  fs.writeFileSync(path.join(source, "routing.txt"), "additional payload bytes\n");
  const expected = inspectPolicy(source, () => null);
  const inspected = [];
  f.runtime.policyMetadata = (directory) => { inspected.push(directory); return null; };
  const scope = configScopes(parseArguments(["install", "--global"], f.runtime.cwd), f.runtime)[0];

  const policy = targetPolicy(scope, { runtime: f.runtime, target: "0.1.0", report: { runner_version: "0.1.0" } });

  assert.deepEqual(inspected, [source]);
  assert.equal(policy.digest, expected.digest);
  assert.ok(policy.path.includes(expected.digest));
  assert.equal(fs.existsSync(f.config), false);
});

test("independent runtimes retain success, refusal and native undefined behavior", async (context) => {
  const accepted = fixture(context);
  const denied = fixture(context);
  const checks = [];
  const refusals = [];
  accepted.runtime.policyMetadata = (directory) => { checks.push(directory); return null; };
  denied.runtime.policyMetadata = (directory) => { refusals.push(directory); throw new Error("isolated metadata refusal"); };

  const installed = await accepted.setup(["install", "--yes"]);
  const rejected = await denied.setup(["install", "--yes"]);
  const unchanged = await accepted.setup(["update", "--to", "0.1.0", "--yes"]);

  assert.ok(checks.length > 0);
  assert.ok(refusals.length > 0);
  assert.equal(rejected.error.code, "policy_reparse_check_failed");
  assert.ok(rejected.error.message.includes("isolated metadata refusal"));
  assert.equal(fs.existsSync(denied.config), false);
  assert.equal(installed.exit_code, 0, JSON.stringify(installed));
  assert.equal(unchanged.status, "unchanged", JSON.stringify(unchanged));
  const directory = accepted.managedPath();
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const observed = inspectPolicy(directory, () => null);
  const manifest = JSON.parse(fs.readFileSync(installed.manifest_path));
  assert.equal(manifest.installs[installed.scopes[0].id].skill.digest, observed.digest);
  assert.deepEqual(fs.readFileSync(path.join(directory, "SKILL.md")), fs.readFileSync(path.join(accepted.packageRoot, "skills/memocap/SKILL.md")));
  assert.ok(checks.includes(directory));
  assert.ok(checks.some((scanned) => scanned.includes(`${path.sep}.memocap-policy-`)));
  const receiptCounts = [checks.length, refusals.length];
  for (const explicitUndefined of [false, true]) {
    const native = fixture(context, { metadata: "native" });
    if (explicitUndefined) native.runtime.policyMetadata = undefined;
    const report = await native.setup(["install", "--yes"]);
    assert.equal(report.exit_code, 0, JSON.stringify(report));
    assert.equal(report.repair_required, false);
  }
  assert.deepEqual([checks.length, refusals.length], receiptCounts);
  assert.ok(checks.every((scanned) => [accepted.root, fs.realpathSync(accepted.root)].some((root) => scanned.startsWith(`${root}${path.sep}`))));
  assert.ok(refusals.every((scanned) => [denied.root, fs.realpathSync(denied.root)].some((root) => scanned.startsWith(`${root}${path.sep}`))));
  const removed = await accepted.setup(["uninstall", "--yes"]);
  assert.equal(removed.exit_code, 0, JSON.stringify(removed));
  assert.equal(fs.existsSync(directory), false);
});

test("metadata inspection preserves real config CAS against a staging-time edit", async (context) => {
  const f = fixture(context);
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, "{}\n");
  const userBytes = Buffer.from('{"model":"concurrent/metadata"}\n');
  const edits = [];
  f.runtime.policyMetadata = (directory) => {
    if (directory.includes(`${path.sep}.memocap-policy-`)) {
      edits.push(directory);
      fs.writeFileSync(f.config, userBytes);
    }
    return null;
  };

  const report = await f.setup(["install", "--yes"]);

  assert.equal(edits.length, 1, "the staged copy inspection must cause this edit");
  assert.equal(report.error.code, "concurrent_change");
  assert.equal(report.status, "partial");
  assert.deepEqual(fs.readFileSync(f.config), userBytes);
  const manifest = JSON.parse(fs.readFileSync(report.manifest_path));
  const pending = Object.values(manifest.installs)[0];
  assert.ok(pending.intent);
  assert.deepEqual(fs.readFileSync(path.join(pending.intent.skill.path, "SKILL.md")), fs.readFileSync(path.join(f.packageRoot, "skills/memocap/SKILL.md")));
});
