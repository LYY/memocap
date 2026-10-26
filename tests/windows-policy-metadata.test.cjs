"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const test = require("node:test");

const directory = "C:\\policy 中文\\space 'quote' \"double\" $(throw 'injected'); & -arg";
const response = (stdout, overrides = {}) => ({ status: 0, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), ...overrides });

test("metadata paths are UTF-8 stdin data with fixed bounded PowerShell arguments and one call", async (context) => {
  context.mock.property(process, "env", { ...process.env, SystemRoot: "C:\\Windows" });
  const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");
  const invocations = [];
  const run = (...args) => { invocations.push(args); return response('{"status":"ok"}\r\n'); };

  assert.equal(inspectWindowsMetadata(directory, run), null);
  assert.equal(invocations.length, 1);
  const [executable, argv, options] = invocations[0];
  assert.equal(executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(argv.slice(0, -1), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(argv.length, 4);
  assert.equal(Buffer.isBuffer(options.input), true);
  assert.deepEqual(JSON.parse(options.input.toString("utf8")), { root: directory });
  assert.equal(options.timeout, 10000);
  assert.equal(options.maxBuffer, 65536);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  const script = Buffer.from(argv[3], "base64").toString("utf16le");
  assert.equal(script.includes(directory), false);
  inspectWindowsMetadata("D:\\different", run);
  assert.deepEqual(invocations[1].slice(0, 2), invocations[0].slice(0, 2));
});

for (const observed of [directory, `${directory}\\hidden\\链接`]) {
  test("metadata returns the observed reparse path without depending on its tag", async (context) => {
    context.mock.property(process, "env", { ...process.env, SystemRoot: "C:\\Windows" });
    const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");
    const scanned = response(JSON.stringify({ status: "reparse", path: observed }));

    assert.equal(inspectWindowsMetadata(directory, () => scanned), observed);
  });
}

const failures = [
  ["empty output", response("")],
  ["malformed JSON", response("{")],
  ["two JSON objects", response('{"status":"ok"}\n{"status":"ok"}')],
  ["null", response("null")],
  ["array", response('[{"status":"ok"}]')],
  ["implicit success", response("{}")],
  ["wrong status", response('{"status":true}')],
  ["incomplete scan", response('{"status":"partial"}')],
  ["extra success fields", response('{"status":"ok","path":"ignored"}')],
  ["missing reparse path", response('{"status":"reparse"}')],
  ["relative reparse path", response('{"status":"reparse","path":"child"}')],
  ["outside reparse path", response('{"status":"reparse","path":"D:\\\\outside"}')],
  ["invalid UTF-8", response("", { stdout: Buffer.from([255]) })],
  ["partial UTF-8 after JSON", response("", { stdout: Buffer.concat([Buffer.from('{"status":"ok"}'), Buffer.from([0xc3])]) })],
  ["nonzero exit", response('{"status":"ok"}', { status: 9, stderr: Buffer.from("native diagnostic") })],
  ["signal termination", response('{"status":"ok"}', { status: null, signal: "SIGTERM" })],
  ...["ENOENT", "ETIMEDOUT", "ENOBUFS"].map((code) => [code, response('{"status":"ok"}', { error: Object.assign(new Error(`actual ${code}`), { code }) })]),
  ...["attributes", "enumerate"].map((operation) => [operation, response(JSON.stringify({ status: "error", operation, path: directory, message: `actual ${operation} failure` }), { status: 1 })]),
];

for (const [name, scanned] of failures) {
  test(`metadata fails closed and preserves diagnostics for ${name}`, async (context) => {
    context.mock.property(process, "env", { ...process.env, SystemRoot: "C:\\Windows" });
    const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");

    assert.throws(() => inspectWindowsMetadata(directory, () => scanned), (error) => {
      assert.equal(error.diagnostics, scanned);
      if (scanned.error) assert.equal(error.cause, scanned.error);
      assert.match(error.message, /Windows policy metadata/);
      return true;
    });
  });
}

for (const systemRoot of [undefined, "Windows", "\\Windows", "C:Windows"]) {
  test("metadata refuses a missing or relative SystemRoot without searching PATH", async (context) => {
    const previous = process.env.SystemRoot;
    context.after(() => {
      if (previous === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previous;
    });
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
    const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");
    let calls = 0;

    assert.throws(() => inspectWindowsMetadata(directory, () => { calls++; return response('{"status":"ok"}'); }), /SystemRoot/);
    assert.equal(calls, 0);
  });
}

for (const scanned of [response(JSON.stringify({ status: "reparse", path: path.join(path.resolve("C:\\policy"), "nested") })), response(""), response("", { error: Object.assign(new Error("actual spawn failure"), { code: "ENOENT" }) })]) {
  test("inspection maps metadata refusals to PolicyError before resolving or reading contents", async (context) => {
    const { inspectPolicy, PolicyError } = await import("../lib/policy.mjs");
    context.mock.property(process, "platform", "win32");
    context.mock.property(process, "env", { ...process.env, SystemRoot: "C:\\Windows" });
    context.mock.method(fs, "lstatSync", () => ({ isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true }));
    context.mock.method(fs, "realpathSync", () => assert.fail("metadata refusal must precede realpath"));
    context.mock.method(childProcess, "spawnSync", () => scanned);
    syncBuiltinESMExports();
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });
    const reparse = scanned.stdout.toString().includes("reparse");

    assert.throws(() => inspectPolicy("C:\\policy"), (error) => {
      assert.ok(error instanceof PolicyError);
      assert.equal(error.code, reparse ? "policy_file_type" : "policy_reparse_check_failed");
      assert.equal(error.path, reparse ? path.join(path.resolve("C:\\policy"), "nested") : path.resolve("C:\\policy"));
      if (!reparse) assert.equal(error.cause.diagnostics, scanned);
      return true;
    });
  });
}

test("non-Windows inspection never invokes a process", { skip: process.platform === "win32" }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap metadata native "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "SKILL.md"), "<!-- memocap:begin -->\nfixture\n<!-- memocap:end -->");
  const { inspectPolicy } = await import("../lib/policy.mjs");
  context.mock.method(childProcess, "spawnSync", () => assert.fail("non-Windows process invocation"));
  syncBuiltinESMExports();
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports(); });

  assert.equal(inspectPolicy(root).files.length, 1);
});
