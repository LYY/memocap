"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const begin = "<!-- memocap:begin -->";
const end = "<!-- memocap:end -->";
const main = Buffer.from(`---\nname: memocap\n---\n${begin}\r\nfixture\r\n${end}\r\n`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap policy "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "references"));
  fs.writeFileSync(path.join(root, "SKILL.md"), main);
  fs.writeFileSync(path.join(root, "references/z.md"), Buffer.from([0, 255, 13, 10]));
  fs.writeFileSync(path.join(root, "references/A.md"), "A\r\n");
  return root;
}

test("inspection hashes a canonical sorted raw-byte manifest without rewriting files", async (context) => {
  const directory = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const expected = [
    { path: "SKILL.md", size: main.length, sha256: sha256(main) },
    { path: "references/A.md", size: 3, sha256: sha256(Buffer.from("A\r\n")) },
    { path: "references/z.md", size: 4, sha256: sha256(Buffer.from([0, 255, 13, 10])) },
  ];
  const policy = inspectPolicy(path.join(directory, "."));
  assert.deepEqual(policy.files, expected);
  assert.equal(policy.digest, sha256(JSON.stringify(expected)));
  assert.equal(policy.directory, fs.realpathSync(directory));
  assert.equal(policy.mainPath, path.join(fs.realpathSync(directory), "SKILL.md"));
  assert.equal(policy.rules, main.toString().slice(main.indexOf(begin), main.indexOf(end) + end.length));
  assert.deepEqual(fs.readFileSync(path.join(directory, "SKILL.md")), main);
});

test("reference tampering changes identity even when the main file and version are identical", async (context) => {
  const directory = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const before = inspectPolicy(directory);
  fs.writeFileSync(path.join(directory, "references/A.md"), "tampered");
  const after = inspectPolicy(directory);
  assert.notEqual(after.digest, before.digest);
  assert.equal(after.rules, before.rules);
});

test("identical bytes in different roots and creation orders have identical identity", async (context) => {
  const directory = fixture(context);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "memocap reordered "));
  context.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.mkdirSync(path.join(other, "references"));
  for (const name of ["references/A.md", "references/z.md", "SKILL.md"]) fs.copyFileSync(path.join(directory, name), path.join(other, name));
  const { inspectPolicy } = await import("../lib/policy.mjs");
  assert.equal(inspectPolicy(other).digest, inspectPolicy(directory).digest);
});

test("missing main is an observable filesystem failure without repair", async (context) => {
  const directory = fixture(context);
  fs.unlinkSync(path.join(directory, "SKILL.md"));
  const { inspectPolicy } = await import("../lib/policy.mjs");
  assert.throws(() => inspectPolicy(directory), { code: "ENOENT" });
  assert.deepEqual(fs.readdirSync(directory), ["references"]);
});

for (const contents of ["", `${end}\nx\n${begin}`, `${begin}\nx`, `${begin}\nx\n${end}\n${begin}\ny\n${end}`, `${begin}\n \n${end}`, `${begin}\nx\n${end}\n<!-- memocap:begin`]) {
  test("malformed or duplicate markers refuse policy selection", async (context) => {
    const directory = fixture(context);
    fs.writeFileSync(path.join(directory, "SKILL.md"), contents);
    const { inspectPolicy } = await import("../lib/policy.mjs");
    assert.throws(() => inspectPolicy(directory), { code: "policy_markers" });
  });
}

for (const entry of ["SKILL.md", "references", "references/outside.md", "."]) {
  test(`inspection refuses a linked payload at ${entry}`, async (context) => {
    const directory = fixture(context);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "memocap outside "));
    context.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const linked = entry === "." ? path.join(outside, "alias") : path.join(directory, entry);
    if (entry !== ".") fs.rmSync(linked, { recursive: true, force: true });
    const target = entry === "SKILL.md" ? path.join(directory, "references/A.md") : directory;
    fs.symlinkSync(target, linked, entry === "SKILL.md" ? "file" : process.platform === "win32" ? "junction" : "dir");
    const { inspectPolicy } = await import("../lib/policy.mjs");
    assert.throws(() => inspectPolicy(entry === "." ? linked : directory), { code: "policy_file_type" });
  });
}

test("inspection refuses special filesystem objects instead of omitting them", { skip: process.platform === "win32" }, async (context) => {
  const directory = fixture(context);
  execFileSync("mkfifo", [path.join(directory, "pipe")]);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  assert.throws(() => inspectPolicy(directory), { code: "policy_file_type" });
});

test("Windows inspection accepts a completed metadata scan before resolving or reading the payload", async (context) => {
  const directory = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const expected = inspectPolicy(directory);
  const moduleURL = pathToFileURL(path.join(__dirname, "../lib/policy.mjs")).href;
  const script = `
    import fs from "node:fs";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const { inspectPolicy } = await import(process.argv[1]);
    const events = [];
    for (const method of ["lstatSync", "realpathSync", "readdirSync", "readFileSync"]) {
      const original = fs[method];
      fs[method] = (...args) => { events.push(method); return original(...args); };
    }
    let calls = 0;
    childProcess.spawnSync = () => {
      calls++;
      events.push("metadata");
      return { status: 0, signal: null, stdout: Buffer.from('{"status":"ok"}'), stderr: Buffer.alloc(0) };
    };
    syncBuiltinESMExports();
    process.env.SystemRoot = "C:\\\\Windows";
    Object.defineProperty(process, "platform", { value: "win32" });
    const policy = inspectPolicy(process.argv[2]);
    process.stdout.write(JSON.stringify({ policy, calls, events }));
  `;
  const observed = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, moduleURL, directory], { encoding: "utf8" }));
  assert.deepEqual(observed.policy, expected);
  assert.equal(observed.calls, 1);
  assert.deepEqual(observed.events.slice(0, 3), ["lstatSync", "metadata", "realpathSync"]);
  assert.deepEqual(fs.readFileSync(path.join(directory, "SKILL.md")), main);
});
