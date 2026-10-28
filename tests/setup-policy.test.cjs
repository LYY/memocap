"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function fixture(context) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memocap policy home "));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = path.join(home, "runner package/skills/memocap");
  fs.cpSync(path.join(__dirname, "../skills/memocap"), source, { recursive: true });
  const metadataChecks = [];
  const policyMetadata = (directory) => { metadataChecks.push(directory); return null; };
  return { home, source, metadataChecks, runtime: { cwd: home, platform: process.platform, env: { HOME: home, USERPROFILE: home }, policyMetadata } };
}

for (const mode of ["default", "xdg", "custom", "project"]) {
  test(`policyDirectory resolves ${mode} independently of an explicit config edit target`, async (context) => {
    const { home, source, runtime, metadataChecks } = fixture(context);
    const { inspectPolicy } = await import("../lib/policy.mjs");
    const { policyDirectory } = await import("../scripts/setup/policy.mjs");
    runtime.env.XDG_CONFIG_HOME = mode === "xdg" ? path.join(home, "xdg config") : undefined;
    runtime.env.OPENCODE_CONFIG_DIR = ["custom", "project"].includes(mode) ? "custom config" : undefined;
    const scope = { kind: mode === "project" ? "project" : "global", directory: path.join(home, "project with spaces"), config: path.join(home, "unrelated/edit.jsonc") };
    const root = mode === "project" ? path.join(scope.directory, ".opencode") : mode === "custom" ? path.join(home, "custom config") : mode === "xdg" ? path.join(home, "xdg config/opencode") : path.join(home, ".config/opencode");
    const digest = inspectPolicy(source, runtime.policyMetadata).digest;
    assert.deepEqual(metadataChecks, [source]);
    assert.equal(policyDirectory(scope, runtime, "0.3.0", digest), path.join(root, `memocap/policies/0.3.0-${digest}/memocap`));
  });
}

test("Windows policy paths use native drive and separator semantics", async () => {
  const { policyDirectory } = await import("../scripts/setup/policy.mjs");
  const runtime = { platform: "win32", cwd: "C:\\work tree", env: { USERPROFILE: "C:\\Users\\Example", OPENCODE_CONFIG_DIR: "D:\\OpenCode config" } };
  assert.equal(policyDirectory({ kind: "global" }, runtime, "0.3.0", "a".repeat(64)), `D:\\OpenCode config\\memocap\\policies\\0.3.0-${"a".repeat(64)}\\memocap`);
  assert.equal(policyDirectory({ kind: "project", directory: "E:\\project space" }, runtime, "0.3.0", "a".repeat(64)), `E:\\project space\\.opencode\\memocap\\policies\\0.3.0-${"a".repeat(64)}\\memocap`);
});

test("path construction rejects untrusted versions and digests before filesystem writes", async (context) => {
  const { runtime } = fixture(context);
  const { policyDirectory } = await import("../scripts/setup/policy.mjs");
  assert.throws(() => policyDirectory({ kind: "global" }, runtime, "../../outside", "a".repeat(64)), { code: "invalid_version" });
  assert.throws(() => policyDirectory({ kind: "global" }, runtime, "0.3.0", "../outside"), { code: "policy_digest" });
  assert.throws(() => policyDirectory({ kind: "unknown" }, runtime, "0.3.0", "a".repeat(64)), { code: "policy_scope" });
});

test("copyPolicy installs complete byte-identical files then reuses an identical payload", async (context) => {
  const { home, source, runtime, metadataChecks } = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const { copyPolicy } = await import("../scripts/setup/policy.mjs");
  const expected = inspectPolicy(source, runtime.policyMetadata);
  const destination = path.join(home, "managed payload/memocap");
  const installed = copyPolicy(source, destination, expected.digest, runtime.policyMetadata);
  assert.ok(metadataChecks.some((directory) => directory.includes(`${path.sep}.memocap-policy-`)));
  assert.ok(metadataChecks.includes(destination));
  assert.equal(installed.status, "changed");
  assert.equal(installed.digest, expected.digest);
  for (const file of expected.files) assert.deepEqual(fs.readFileSync(path.join(destination, file.path)), fs.readFileSync(path.join(source, file.path)));
  assert.equal(copyPolicy(source, destination, expected.digest, runtime.policyMetadata).status, "unchanged");
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), ["memocap"]);
});

test("a preexisting different payload survives a rename collision", async (context) => {
  const { home, source, runtime } = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const { copyPolicy } = await import("../scripts/setup/policy.mjs");
  const expected = inspectPolicy(source, runtime.policyMetadata);
  const destination = path.join(home, "managed/memocap");
  const rename = fs.renameSync;
  context.mock.method(fs, "renameSync", (staging, target) => {
    fs.cpSync(source, destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "references/user.md"), "user bytes");
    return rename(staging, target);
  });
  assert.throws(() => copyPolicy(source, destination, expected.digest, runtime.policyMetadata), { code: "policy_collision" });
  assert.equal(fs.readFileSync(path.join(destination, "references/user.md"), "utf8"), "user bytes");
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), ["memocap"]);
});

test("same-version changed destination is preserved without recopying", async (context) => {
  const { home, source, runtime } = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const { copyPolicy } = await import("../scripts/setup/policy.mjs");
  const expected = inspectPolicy(source, runtime.policyMetadata);
  const destination = path.join(home, "managed/memocap");
  fs.cpSync(source, destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "references/user.md"), "preserve");
  assert.throws(() => copyPolicy(source, destination, expected.digest, runtime.policyMetadata), { code: "policy_collision" });
  assert.equal(fs.readFileSync(path.join(destination, "references/user.md"), "utf8"), "preserve");
});

for (const fault of ["throw", "tamper"]) {
  test(`staging ${fault} cleans partial payload and preserves an unrelated installed version`, async (context) => {
    const { home, source, runtime } = fixture(context);
    const { inspectPolicy } = await import("../lib/policy.mjs");
    const { copyPolicy } = await import("../scripts/setup/policy.mjs");
    const expected = inspectPolicy(source, runtime.policyMetadata);
    const parent = path.join(home, "policies");
    const previous = path.join(parent, "old/memocap");
    fs.cpSync(source, previous, { recursive: true });
    const copy = fs.cpSync;
    context.mock.method(fs, "cpSync", (from, to, options) => {
      copy(from, to, options);
      if (fault === "throw") throw Object.assign(new Error("injected partial copy"), { code: "EIO" });
      fs.writeFileSync(path.join(to, "references/user.md"), "unexpected");
    });
    assert.throws(() => copyPolicy(source, path.join(parent, "new"), expected.digest, runtime.policyMetadata), { code: fault === "throw" ? "EIO" : "policy_digest" });
    assert.equal(inspectPolicy(previous, runtime.policyMetadata).digest, expected.digest);
    assert.deepEqual(fs.readdirSync(parent), ["old"]);
  });
}

test("a stale source digest is refused before creating a destination", async (context) => {
  const { home, source, runtime } = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const { copyPolicy } = await import("../scripts/setup/policy.mjs");
  const digest = inspectPolicy(source, runtime.policyMetadata).digest;
  fs.writeFileSync(path.join(source, "references/user.md"), "changed source");
  assert.throws(() => copyPolicy(source, path.join(home, "absent/memocap"), digest, runtime.policyMetadata), { code: "policy_digest" });
  assert.equal(fs.existsSync(path.join(home, "absent")), false);
});

test("destination changes during final rename are reported instead of claiming a verified copy", async (context) => {
  const { home, source, runtime } = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const { copyPolicy } = await import("../scripts/setup/policy.mjs");
  const digest = inspectPolicy(source, runtime.policyMetadata).digest;
  const destination = path.join(home, "installed", "memocap");
  const rename = fs.renameSync;
  context.mock.method(fs, "renameSync", (from, to) => {
    rename(from, to);
    fs.writeFileSync(path.join(to, "references/user.md"), "concurrent change");
  });
  assert.throws(() => copyPolicy(source, destination, digest, runtime.policyMetadata), { code: "policy_digest" });
  assert.equal(fs.readFileSync(path.join(destination, "references/user.md"), "utf8"), "concurrent change");
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), ["memocap"]);
});
