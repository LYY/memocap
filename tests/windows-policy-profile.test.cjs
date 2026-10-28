"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { snapshot } = require("./packaged-runtime.cjs");

const scanned = (overrides = {}) => ({ status: 0, signal: null, stdout: Buffer.from('{"status":"ok"}'), stderr: Buffer.alloc(0), ...overrides });

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap metadata parent "));
  const remove = fs.rmSync;
  context.after(() => remove(root, { recursive: true, force: true }));
  context.mock.method(os, "tmpdir", () => root);
  context.mock.property(process, "env", { SystemRoot: "C:\\Windows", HOME: root, USERPROFILE: root,
    PATH: "parent-path", Path: "other-parent-path", PSModulePath: "parent-modules",
    PSModuleAnalysisCachePath: "parent-cache", COR_ENABLE_PROFILING: "1", MEMOCAP_TOKEN: "parent-secret" });
  fs.writeFileSync(path.join(root, "keep"), "parent bytes");
  return root;
}

test("metadata owns a fresh child profile until synchronous completion without inheriting parent overrides", async (context) => {
  const root = fixture(context);
  const before = snapshot([root]);
  const parentEnv = { ...process.env };
  const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");
  const ownedRoots = [];

  const run = (_executable, _argv, options) => {
    const env = options.env;
    ownedRoots.push(options.cwd);
    assert.equal(fs.statSync(options.cwd).isDirectory(), true);
    assert.equal(path.dirname(options.cwd), root);
    assert.equal(env.HOME, path.join(options.cwd, "profile"));
    assert.equal(env.USERPROFILE, env.HOME);
    assert.equal(env.HOMEDRIVE + env.HOMEPATH, env.HOME);
    assert.equal(env.APPDATA, path.join(env.HOME, "AppData", "Roaming"));
    assert.equal(env.LOCALAPPDATA, path.join(env.HOME, "AppData", "Local"));
    assert.equal(env.TEMP, path.join(options.cwd, "tmp"));
    assert.equal(env.TMP, env.TEMP);
    assert.equal(env.TMPDIR, env.TEMP);
    assert.equal(env.PSModuleAnalysisCachePath, path.join(env.LOCALAPPDATA, "Microsoft", "Windows", "PowerShell", "ModuleAnalysisCache"));
    for (const directory of [env.APPDATA, path.dirname(env.PSModuleAnalysisCachePath), env.TEMP]) assert.ok(fs.statSync(directory).isDirectory());
    for (const name of ["MEMOCAP_TOKEN", "COR_ENABLE_PROFILING", "Path"]) assert.equal(Object.hasOwn(env, name), false);
    assert.equal(new Set(Object.keys(env).map((key) => key.toUpperCase())).size, Object.keys(env).length);
    assert.equal(env.SystemRoot, "C:\\Windows");
    assert.equal(env.WINDIR, env.SystemRoot);
    assert.equal(env.PATH, "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0");
    assert.equal(env.PSModulePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
    fs.writeFileSync(env.PSModuleAnalysisCachePath, "child cache");
    fs.writeFileSync(path.join(env.TEMP, "runtime"), "child temporary bytes");
    return scanned();
  };
  inspectWindowsMetadata("D:\\payload", run);
  inspectWindowsMetadata("D:\\payload", run);

  assert.notEqual(ownedRoots[0], ownedRoots[1]);
  assert.ok(ownedRoots.every((owned) => !fs.existsSync(owned)));
  assert.deepEqual(snapshot([root]), before);
  assert.deepEqual(process.env, parentEnv);
});

for (const [name, outcome] of [
  ["nonzero", scanned({ status: 9 })],
  ["signal", scanned({ status: null, signal: "SIGTERM" })],
  ["timeout", scanned({ error: Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }) })],
  ["buffer overflow", scanned({ error: Object.assign(new Error("output limit"), { code: "ENOBUFS" }) })],
  ["malformed JSON", scanned({ stdout: Buffer.from("{") })],
  ["invalid UTF8", scanned({ stdout: Buffer.from([255]) })],
  ["spawn throws", new Error("spawn threw")],
]) {
  test(`metadata removes child resources after ${name}`, async (context) => {
    const root = fixture(context);
    const before = snapshot([root]);
    const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");
    let owned;

    assert.throws(() => inspectWindowsMetadata("D:\\payload", (_executable, _argv, options) => {
      owned = options.cwd;
      fs.writeFileSync(path.join(options.env.TEMP, "child"), "temporary bytes");
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }));

    assert.equal(typeof owned, "string");
    assert.equal(fs.existsSync(owned), false);
    assert.deepEqual(snapshot([root]), before);
  });
}

test("metadata removes its owned leaf when profile creation partially fails", async (context) => {
  const root = fixture(context);
  const before = snapshot([root]);
  const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");
  const mkdir = fs.mkdirSync;
  context.mock.method(fs, "mkdirSync", (directory, options) => {
    mkdir(directory, options);
    throw Object.assign(new Error("fixture directory failure"), { code: "EACCES" });
  });

  assert.throws(() => inspectWindowsMetadata("D:\\payload", () => assert.fail("spawn after preparation failure")), /fixture directory failure/);

  assert.deepEqual(snapshot([root]), before);
});

for (const primary of [null, scanned({ error: Object.assign(new Error("original timeout"), { code: "ETIMEDOUT" }) })]) {
  test(`metadata exposes cleanup failure ${primary ? "alongside its primary error" : "after success"}`, async (context) => {
    const root = fixture(context);
    const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");
    const remove = fs.rmSync;
    context.mock.method(fs, "rmSync", () => { throw Object.assign(new Error("fixture cleanup failure"), { code: "EBUSY" }); });
    context.after(() => { context.mock.restoreAll(); remove(root, { recursive: true, force: true }); });

    assert.throws(() => inspectWindowsMetadata("D:\\payload", () => primary || scanned()), (error) => {
      assert.match(error.message, /cleanup.*EBUSY/);
      if (primary) {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /original timeout/);
        assert.equal(error.cause.diagnostics, primary);
        assert.equal(error.cause.cause, primary.error);
        assert.equal(error.errors[1].code, "EBUSY");
      }
      return true;
    });
  });
}

test("metadata refuses a temporary parent inside the scanned payload before allocating resources", async (context) => {
  const root = fixture(context);
  const before = snapshot([root]);
  const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");

  assert.throws(() => inspectWindowsMetadata(root, () => assert.fail("spawn must not be called")), /temporary parent.*payload/);

  assert.deepEqual(snapshot([root]), before);
});

test("metadata does not create a missing temporary parent", async (context) => {
  const root = fixture(context);
  context.mock.method(os, "tmpdir", () => path.join(root, "missing"));
  const before = snapshot([root]);
  const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");

  assert.throws(() => inspectWindowsMetadata("D:\\payload", () => assert.fail("spawn must not be called")), { code: "ENOENT" });

  assert.deepEqual(snapshot([root]), before);
});
