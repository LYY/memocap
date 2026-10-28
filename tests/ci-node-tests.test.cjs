"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const launcherPath = path.resolve(__dirname, "../scripts/test-node-contracts.mjs");
const linuxOnly = [
  "release-ancestry.test.cjs",
  "release-reconciliation.test.cjs",
  "release-registry.test.cjs",
  "release-registry-retry.test.cjs",
];
const portable = [
  "release-check.test.cjs",
  "setup-fixture-native.test.cjs",
  "windows-policy-native.test.cjs",
  "future-ordinary.test.cjs",
  "release-future.test.cjs",
];

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-ci-node-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "tests");
  fs.mkdirSync(directory);
  for (const name of [...linuxOnly, ...portable, "helper.cjs"]) {
    fs.writeFileSync(path.join(directory, name), "");
  }
  fs.mkdirSync(path.join(directory, "nested"));
  fs.writeFileSync(path.join(directory, "nested", "nested.test.cjs"), "");
  fs.mkdirSync(path.join(directory, "directory.test.cjs"));
  return directory;
}

test("Linux selects every top-level Node test file", async (context) => {
  const directory = fixture(context);
  const { selectNodeTests } = await import(pathToFileURL(launcherPath).href);

  const selected = selectNodeTests("linux", directory);

  assert.deepEqual(selected, [...linuxOnly, ...portable].sort().map((name) => path.join(directory, name)));
});

for (const platform of ["darwin", "win32", "freebsd"]) {
  test(`${platform} excludes exactly the four Linux release suites`, async (context) => {
    const directory = fixture(context);
    const { selectNodeTests } = await import(pathToFileURL(launcherPath).href);

    const selected = selectNodeTests(platform, directory);

    assert.deepEqual(selected, [...portable].sort().map((name) => path.join(directory, name)));
  });
}

test("new ordinary test files are discovered after an earlier selection", async (context) => {
  const directory = fixture(context);
  const { selectNodeTests } = await import(pathToFileURL(launcherPath).href);
  selectNodeTests("darwin", directory);
  const added = path.join(directory, "new-ordinary.test.cjs");
  fs.writeFileSync(added, "");

  const selected = selectNodeTests("darwin", directory);

  assert.ok(selected.includes(added));
});

for (const exitCode of [0, 1]) {
  test(`direct launcher execution propagates test exit ${exitCode}`, (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-ci-run-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "scripts"));
    fs.mkdirSync(path.join(root, "tests"));
    const launcher = path.join(root, "scripts", "test-node-contracts.mjs");
    fs.copyFileSync(launcherPath, launcher);
    fs.writeFileSync(path.join(root, "tests", "ordinary.test.cjs"), `
      const test = require("node:test");
      test("fixture outcome", () => {
        console.log("fixture-executed");
        require("node:assert/strict").equal(${exitCode}, 0);
      });
    `);

    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;

    const execution = spawnSync(process.execPath, [launcher], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      env,
    });

    assert.equal(execution.status, exitCode, execution.stderr);
    assert.match(execution.stdout, /fixture-executed/);
  });
}
