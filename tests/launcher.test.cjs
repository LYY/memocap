"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const launcherPath = path.resolve(__dirname, "../bin/cli.cjs");
const { resolveReleaseAsset, verifyCachedBinary } = require(launcherPath);

function runResolver(platform, arch) {
  const script = `
    const { resolveReleaseAsset } = require(${JSON.stringify(launcherPath)});
    const result = resolveReleaseAsset(${JSON.stringify(platform)}, ${JSON.stringify(arch)});
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  `;
  return spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, MEMOCAP_BINARY: process.execPath },
  });
}

function createTempBinary(context, source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-launcher-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const binaryPath = path.join(tempDir, "memocap-test.cjs");
  fs.writeFileSync(binaryPath, `#!${process.execPath}\n${source}`, {
    mode: 0o755,
  });
  return binaryPath;
}

for (const target of [
  {
    platform: "linux",
    arch: "x64",
    name: "memocap-x86_64-unknown-linux-gnu",
  },
  {
    platform: "darwin",
    arch: "arm64",
    name: "memocap-aarch64-apple-darwin",
  },
  {
    platform: "win32",
    arch: "x64",
    name: "memocap-x86_64-pc-windows-msvc.exe",
  },
]) {
  test(`resolves LYY release asset for ${target.platform}/${target.arch}`, () => {
    // Given
    const expected = {
      name: target.name,
      url: `https://github.com/LYY/memocap/releases/download/v0.0.1/${target.name}`,
      checksumUrl: `https://github.com/LYY/memocap/releases/download/v0.0.1/${target.name}.sha256`,
    };

    // When
    const execution = runResolver(target.platform, target.arch);

    // Then
    assert.equal(execution.status, 0, execution.stderr);
    assert.deepEqual(JSON.parse(execution.stdout), expected);
  });
}

test("rejects unsupported launcher target without network access", () => {
  // Given
  const script = `
    const { resolveReleaseAsset } = require(${JSON.stringify(launcherPath)});
    try {
      resolveReleaseAsset("freebsd", "arm64");
    } catch (error) {
      process.stderr.write(error.message);
      process.exit(23);
    }
    process.exit(0);
  `;

  // When
  const execution = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, MEMOCAP_BINARY: process.execPath },
  });

  // Then
  assert.equal(execution.status, 23);
  assert.equal(
    execution.stderr,
    "unsupported platform freebsd/arm64. Supported: linux/x64, darwin/arm64, win32/x64.",
  );
});

test("rejects a cached binary whose checksum manifest does not match", (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-launcher-cache-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const name = "memocap-x86_64-unknown-linux-gnu";
  const binary = path.join(tempDir, name);
  const checksum = `${binary}.sha256`;
  const digest = crypto.createHash("sha256").update("trusted").digest("hex");
  fs.writeFileSync(binary, "trusted");
  fs.writeFileSync(checksum, `${digest}  ${name}\n`);

  assert.equal(verifyCachedBinary(binary, checksum, name), true);

  fs.writeFileSync(binary, "modified");

  assert.equal(verifyCachedBinary(binary, checksum, name), false);
});

test("loads release resolver without launching a child process", (context) => {
  // Given
  const binaryPath = createTempBinary(
    context,
    'process.stdout.write("unexpected launch\\n");\nprocess.exit(19);\n',
  );
  const script = `
    require(${JSON.stringify(launcherPath)});
    setImmediate(() => process.exit(0));
  `;

  // When
  const execution = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, MEMOCAP_BINARY: binaryPath },
  });

  // Then
  assert.equal(execution.status, 0);
  assert.equal(execution.stdout, "");
  assert.equal(execution.stderr, "");
});

test("forwards child output and exit status through MEMOCAP_BINARY", (context) => {
  // Given
  const hookPath = createTempBinary(
    context,
    'const path = require("node:path");\n' +
      `if (path.resolve(process.argv[1]) !== ${JSON.stringify(launcherPath)}) {\n` +
      '  const argument = path.relative(process.cwd(), process.argv[1]);\n' +
      '  process.stdout.write(`stdout:${argument}\\n`);\n' +
      '  process.stderr.write(`stderr:${argument}\\n`);\n' +
      "  process.exit(17);\n" +
      "}\n",
  );

  // When
  const execution = spawnSync(process.execPath, [launcherPath, "forwarded"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEMOCAP_BINARY: process.execPath,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${hookPath}`.trim(),
    },
  });

  // Then
  assert.equal(execution.status, 17, execution.stderr);
  assert.equal(execution.stdout, "stdout:forwarded\n");
  assert.equal(execution.stderr, "stderr:forwarded\n");
});
