"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const nativeWindows = { skip: process.platform !== "win32" };
const main = Buffer.from("<!-- memocap:begin -->\r\nfixture\r\n<!-- memocap:end -->\r\n");
const binary = Buffer.from([0, 255, 128, 13, 10]);

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap windows policy "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "中文 空间 'quote' $(literal)");
  const hidden = path.join(source, "隐藏 目录");
  fs.mkdirSync(hidden, { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), main);
  fs.writeFileSync(path.join(hidden, "中文 reference.bin"), binary);
  const attrib = path.join(process.env.SystemRoot, "System32", "attrib.exe");
  for (const filename of [hidden, path.join(hidden, "中文 reference.bin")]) {
    execFileSync(attrib, ["+H", "+S", filename], { shell: false, windowsHide: true });
    const attributes = execFileSync(attrib, [filename], { encoding: "utf8", windowsHide: true }).split(filename)[0];
    assert.match(attributes, /H/);
    assert.match(attributes, /S/);
  }
  return { root, source, hidden, destination: path.join(root, "managed 中文 空间", "memocap") };
}

test("native Windows scans ordinary nested hidden/system Unicode entries through real attributes", nativeWindows, async (context) => {
  const { source } = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");

  assert.equal(inspectWindowsMetadata(source), null);
  const inspected = inspectPolicy(source);
  assert.deepEqual(inspected.files.map((file) => file.path), ["SKILL.md", "隐藏 目录/中文 reference.bin"]);
  assert.equal(inspected.files[1].size, binary.length);
});

test("native Windows scans hidden/system payload on first use in a fresh packaged profile", nativeWindows, (context) => {
  const { root, source } = fixture(context);
  const { isolatedEnvironment } = require("./packaged-runtime.cjs");
  const env = isolatedEnvironment(path.join(root, "fresh-profile"));
  const moduleURL = require("node:url").pathToFileURL(path.resolve(__dirname, "../lib/policy.mjs")).href;
  const driver = "import(process.argv[1]).then(({inspectPolicy}) => console.log(JSON.stringify(inspectPolicy(process.argv[2]).files)))";

  const output = execFileSync(process.execPath, ["-e", driver, moduleURL, source], {
    env, encoding: "utf8", timeout: 15000, windowsHide: true,
  });

  assert.deepEqual(JSON.parse(output).map((file) => file.path), ["SKILL.md", "隐藏 目录/中文 reference.bin"]);
});

test("native Windows reports missing root attributes without success", nativeWindows, async (context) => {
  const { root } = fixture(context);
  const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");

  assert.throws(() => inspectWindowsMetadata(path.join(root, "missing")), (error) => {
    assert.equal(error.diagnostics.status, 1);
    assert.equal(JSON.parse(error.diagnostics.stdout.toString("utf8")).operation, "attributes");
    return true;
  });
});

test("native Windows copies the complete hidden Unicode payload byte for byte without link privileges", nativeWindows, async (context) => {
  const { source, destination } = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const { copyPolicy } = await import("../scripts/setup/policy.mjs");
  const expected = inspectPolicy(source);

  const installed = copyPolicy(source, destination, expected.digest);

  assert.equal(installed.status, "changed");
  assert.equal(installed.digest, expected.digest);
  assert.deepEqual(fs.readFileSync(path.join(destination, "SKILL.md")), main);
  assert.deepEqual(fs.readFileSync(path.join(destination, "隐藏 目录", "中文 reference.bin")), binary);
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), ["memocap"]);
});

test("native Windows reuses an identical payload without leaving staging", nativeWindows, async (context) => {
  const { source, destination } = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const { copyPolicy } = await import("../scripts/setup/policy.mjs");
  const expected = inspectPolicy(source);
  fs.cpSync(source, destination, { recursive: true });

  const installed = copyPolicy(source, destination, expected.digest);

  assert.equal(installed.status, "unchanged");
  assert.equal(installed.digest, expected.digest);
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), ["memocap"]);
});

test("native Windows preserves an existing different payload on collision", nativeWindows, async (context) => {
  const { source, destination } = fixture(context);
  const { inspectPolicy } = await import("../lib/policy.mjs");
  const { copyPolicy } = await import("../scripts/setup/policy.mjs");
  const expected = inspectPolicy(source);
  fs.cpSync(source, destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "owned.txt"), "keep these bytes");

  assert.throws(() => copyPolicy(source, destination, expected.digest), { code: "policy_collision" });

  assert.equal(fs.readFileSync(path.join(destination, "owned.txt"), "utf8"), "keep these bytes");
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), ["memocap"]);
});

for (const location of ["root", "nested", "hidden"]) {
  test(`native Windows rejects a ${location} junction before following it without elevation`, nativeWindows, async (context) => {
    const { root, source, hidden, destination } = fixture(context);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const linked = location === "root" ? path.join(root, "alias") : path.join(location === "hidden" ? hidden : source, "junction");
    fs.symlinkSync(outside, linked, "junction");
    const inspectedRoot = location === "root" ? linked : source;
    const { inspectWindowsMetadata } = await import("../lib/windows-policy-metadata.mjs");
    const { inspectPolicy } = await import("../lib/policy.mjs");
    const { copyPolicy } = await import("../scripts/setup/policy.mjs");

    assert.equal(inspectWindowsMetadata(inspectedRoot), linked);
    assert.throws(() => inspectPolicy(inspectedRoot), { code: "policy_file_type", path: linked });
    assert.throws(() => copyPolicy(inspectedRoot, destination, "0".repeat(64)), { code: "policy_file_type", path: linked });

    assert.equal(fs.existsSync(path.dirname(destination)), false);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
}
