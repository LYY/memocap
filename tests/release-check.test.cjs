"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const checkerPath = path.resolve(__dirname, "../scripts/check-release.mjs");

function writeFixture(context, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-release-check-"));
  const bin = path.join(root, "bin");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(bin);

  const version = overrides.version ?? "0.0.1";
  const cargoVersion = overrides.cargoVersion ?? version;
  const lockVersion = overrides.lockVersion ?? cargoVersion;
  const repository = overrides.repository ?? "https://github.com/LYY/memocap.git";
  const packageName = overrides.packageName ?? "@lyy-gh/memocap";
  const cargoName = overrides.cargoName ?? "memocap";
  const cargoRepository = overrides.cargoRepository ?? "https://github.com/LYY/memocap";
  const metadata = {
    packages: [
      {
        name: cargoName,
        version: cargoVersion,
        repository: cargoRepository,
      },
    ],
    workspace_members: ["memocap 0.0.1 (path+file:///fixture)"],
  };

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: packageName, version, repository }),
  );
  fs.writeFileSync(
    path.join(root, "Cargo.toml"),
    `[package]\nname = "${cargoName}"\nversion = "${cargoVersion}"\nrepository = "${cargoRepository}"\n`,
  );
  fs.writeFileSync(
    path.join(root, "Cargo.lock"),
    `version = 3\n\n[[package]]\nname = "memocap"\nversion = "${lockVersion}"\n`,
  );
  fs.writeFileSync(
    path.join(bin, "cargo"),
    `#!${process.execPath}\nprocess.stdout.write(process.env.RELEASE_CHECK_METADATA);\n`,
    { mode: 0o755 },
  );

  return { root, metadata };
}

function runCheck(fixture, tag) {
  return spawnSync(process.execPath, [checkerPath, "--root", fixture.root], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(fixture.root, "bin")}:${process.env.PATH}`,
      RELEASE_CHECK_METADATA: JSON.stringify(fixture.metadata),
      RELEASE_TAG: tag,
    },
  });
}

test("accepts synchronized v0.0.1 release metadata", (context) => {
  // Given
  const fixture = writeFixture(context);

  // When
  const execution = runCheck(fixture, "v0.0.1");

  // Then
  assert.equal(execution.status, 0, execution.stderr);
});

test("rejects malformed release tag", (context) => {
  // Given
  const fixture = writeFixture(context);

  // When
  const execution = runCheck(fixture, "v0.0.1.0");

  // Then
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /RELEASE_TAG/);
});

test("rejects release tag that differs from package version", (context) => {
  // Given
  const fixture = writeFixture(context);

  // When
  const execution = runCheck(fixture, "v0.0.2");

  // Then
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /RELEASE_TAG/);
});

test("rejects Cargo.lock version mismatch", (context) => {
  // Given
  const fixture = writeFixture(context, { lockVersion: "0.0.2" });

  // When
  const execution = runCheck(fixture, "v0.0.1");

  // Then
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /Cargo.lock/);
});

test("rejects package identity outside the LYY scope", (context) => {
  // Given
  const fixture = writeFixture(context, { packageName: "memocap" });

  // When
  const execution = runCheck(fixture, "v0.0.1");

  // Then
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /package name/);
});

test("rejects Cargo metadata version mismatch", (context) => {
  // Given
  const fixture = writeFixture(context, { cargoVersion: "0.0.2" });

  // When
  const execution = runCheck(fixture, "v0.0.1");

  // Then
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /Cargo metadata version/);
});
