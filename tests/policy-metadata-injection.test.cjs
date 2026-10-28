"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const test = require("node:test");

const main = Buffer.from("<!-- memocap:begin -->\nfixture\n<!-- memocap:end -->\n");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap metadata "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "managed", "memocap");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "SKILL.md"), main);
  fs.writeFileSync(path.join(source, "reference.bin"), Buffer.from([0, 255, 13, 10]));
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const { copyPolicy } = await import("../scripts/setup/policy.mjs");
  return { root, source, destination, inspectPolicy, copyPolicy, digest: inspectPolicy(source, () => null).digest };
}

test("null metadata retains sorted real-byte hashing and observes absolute root before resolution", async (context) => {
  const f = await fixture(context);
  const events = [];
  for (const method of ["lstatSync", "realpathSync", "readFileSync"]) {
    const original = fs[method];
    context.mock.method(fs, method, (...args) => { events.push(method); return original(...args); });
  }
  const metadata = (directory) => { events.push(directory); return null; };
  const relative = path.relative(process.cwd(), f.source);
  const inspected = f.inspectPolicy(relative, metadata);
  assert.deepEqual(events.slice(0, 3), ["lstatSync", f.source, "realpathSync"]);
  const files = [
    { path: "SKILL.md", size: main.length, sha256: sha256(main) },
    { path: "reference.bin", size: 4, sha256: sha256(Buffer.from([0, 255, 13, 10])) },
  ];
  assert.deepEqual(inspected.files, files);
  assert.equal(inspected.digest, sha256(JSON.stringify(files)));
  fs.writeFileSync(path.join(f.source, "reference.bin"), Buffer.from([0, 254, 13, 10]));
  const changed = f.inspectPolicy(relative, metadata);
  assert.notEqual(changed.digest, inspected.digest);
  assert.equal(changed.rules, inspected.rules);
});

test("root file type is rejected before invoking metadata", async (context) => {
  const f = await fixture(context);
  let calls = 0;
  assert.throws(() => f.inspectPolicy(path.join(f.source, "SKILL.md"), () => { calls++; return null; }), { code: "policy_file_type" });
  assert.equal(calls, 0);
});

for (const fault of ["reparse", "throw"]) {
  test(`metadata ${fault} refuses inspection before realpath or content reads`, async (context) => {
    const f = await fixture(context);
    const cause = new Error("metadata unavailable");
    const reparse = path.join(f.source, "reference.bin");
    const accesses = [];
    for (const method of ["realpathSync", "readdirSync", "readFileSync"]) {
      const original = fs[method];
      context.mock.method(fs, method, (...args) => { accesses.push(method); return original(...args); });
    }
    const metadata = (directory) => {
      assert.equal(directory, f.source);
      if (fault === "throw") throw cause;
      return reparse;
    };
    assert.throws(() => f.inspectPolicy(f.source, metadata), (error) => {
      assert.equal(error.code, fault === "throw" ? "policy_reparse_check_failed" : "policy_file_type");
      assert.equal(error.path, fault === "throw" ? f.source : reparse);
      if (fault === "throw") { assert.equal(error.cause, cause); assert.equal(error.message, cause.message); }
      else assert.equal(error.message, `Reparse point in policy payload: ${reparse}`);
      return true;
    });
    assert.deepEqual(accesses, []);
  });
}

for (const branch of ["install", "reuse", "concurrent", "collision"]) {
  test(`copy ${branch} forwards metadata and preserves real payload identity`, async (context) => {
    const f = await fixture(context);
    const checks = [];
    let staged;
    if (branch === "reuse") fs.cpSync(f.source, f.destination, { recursive: true });
    if (branch === "collision") {
      context.mock.method(fs, "renameSync", () => {
        fs.cpSync(f.source, f.destination, { recursive: true });
        throw Object.assign(new Error("concurrent publication"), { code: "EEXIST" });
      });
    }
    const metadata = (directory) => {
      checks.push(directory);
      if (directory !== f.source && directory !== f.destination) {
        staged = directory;
        if (branch === "concurrent") fs.cpSync(f.source, f.destination, { recursive: true });
      }
      return null;
    };
    const installed = f.copyPolicy(f.source, f.destination, f.digest, metadata);
    assert.deepEqual(checks, branch === "reuse" ? [f.source, f.destination] : [f.source, staged, f.destination]);
    if (branch !== "reuse") assert.equal(path.basename(path.dirname(staged)).startsWith(".memocap-policy-"), true);
    assert.equal(installed.status, branch === "install" ? "changed" : "unchanged");
    assert.equal(installed.digest, f.digest);
    for (const filename of ["SKILL.md", "reference.bin"]) {
      assert.deepEqual(fs.readFileSync(path.join(f.destination, filename)), fs.readFileSync(path.join(f.source, filename)));
    }
    assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), ["memocap"]);
  });
}

for (const boundary of ["source", "existing", "staged", "concurrent", "collision", "final"]) {
  for (const fault of ["reparse", "throw"]) {
    test(`copy ${boundary} metadata ${fault} remains observable and preserves owned bytes`, async (context) => {
      const f = await fixture(context);
      const cause = new Error("metadata failure");
      const accesses = [];
      const checks = [];
      let rejected;
      if (boundary === "existing") fs.cpSync(f.source, f.destination, { recursive: true });
      if (boundary === "collision") {
        context.mock.method(fs, "renameSync", () => {
          fs.cpSync(f.source, f.destination, { recursive: true });
          throw Object.assign(new Error("concurrent publication"), { code: "EEXIST" });
        });
      }
      for (const method of ["realpathSync", "readdirSync", "readFileSync"]) {
        const original = fs[method];
        context.mock.method(fs, method, (...args) => {
          if (rejected !== undefined) accesses.push(method);
          return original(...args);
        });
      }
      const metadata = (directory) => {
        checks.push(directory);
        const staging = directory !== f.source && directory !== f.destination;
        if (staging && boundary === "concurrent") fs.cpSync(f.source, f.destination, { recursive: true });
        if ((boundary === "source" && directory === f.source)
            || (boundary === "staged" && staging)
            || (!["source", "staged"].includes(boundary) && directory === f.destination)) {
          rejected = directory;
          if (fault === "throw") throw cause;
          return path.join(directory, "reference.bin");
        }
        return null;
      };
      assert.throws(() => f.copyPolicy(f.source, f.destination, f.digest, metadata), (error) => {
        assert.equal(error.code, fault === "throw" ? "policy_reparse_check_failed" : "policy_file_type");
        assert.equal(error.path, fault === "throw" ? rejected : path.join(rejected, "reference.bin"));
        if (fault === "throw") assert.equal(error.cause, cause);
        return true;
      });
      assert.deepEqual(accesses, []);
      assert.equal(checks.length, boundary === "source" ? 1 : ["existing", "staged"].includes(boundary) ? 2 : 3);
      context.mock.restoreAll();
      assert.deepEqual(fs.readFileSync(path.join(f.source, "SKILL.md")), main);
      assert.deepEqual(fs.readFileSync(path.join(f.source, "reference.bin")), Buffer.from([0, 255, 13, 10]));
      if (["source", "staged"].includes(boundary)) assert.equal(fs.existsSync(f.destination), false);
      else assert.equal(f.inspectPolicy(f.destination, () => null).digest, f.digest);
      if (fs.existsSync(path.dirname(f.destination))) {
        assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), boundary === "staged" ? [] : ["memocap"]);
      }
    });
  }
}
