"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

function runnerPath(setup) {
  const launcher = path.join(setup.packageRoot, "bin/cli.cjs");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "runner launcher\n", { mode: 0o755 });
  const directory = path.join(setup.root, "npx cache/node_modules/.bin");
  fs.mkdirSync(directory, { recursive: true });
  if (process.platform === "win32") {
    const scope = path.join(directory, "../@lyy-gh");
    fs.mkdirSync(scope);
    fs.symlinkSync(setup.packageRoot, path.join(scope, "memocap"), "junction");
    fs.writeFileSync(path.join(directory, "memocap.cmd"), '@"node" "%~dp0\\..\\@lyy-gh\\memocap\\bin\\cli.cjs" %*\r\n', { mode: 0o755 });
  } else fs.symlinkSync(launcher, path.join(directory, "memocap"));
  setup.env.PATH = `${directory}${path.delimiter}${setup.env.PATH}`;
}

test("npx runner's bundled CLI is not an unowned global installation", async (context) => {
  const setup = fixture(context);
  runnerPath(setup);
  const { discoverCLI } = await import("../scripts/setup/packages.mjs");
  const cli = await discoverCLI(setup.runtime, {});
  assert.equal(cli.version, null);
  assert.equal(cli.executable_path, null);
});

test("a Windows npx cache shim is excluded by its package launcher identity", async (context) => {
  const setup = fixture(context);
  const { discoverCLI } = await import("../scripts/setup/packages.mjs");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    runnerPath(setup);
    const cli = await discoverCLI(setup.runtime, {});
    assert.equal(cli.executable_path, null);
  } finally { Object.defineProperty(process, "platform", platform); }
});

test("npx runner does not shadow the package-manager-owned global executable", async (context) => {
  const setup = fixture(context);
  setup.installCLI("0.1.0");
  runnerPath(setup);
  const { discoverCLI } = await import("../scripts/setup/packages.mjs");
  const cli = await discoverCLI(setup.runtime, {});
  assert.equal(cli.executable_path, setup.cliPath);
});

test("ignoring a runner does not hide an unrelated unowned executable", async (context) => {
  const setup = fixture(context);
  runnerPath(setup);
  fs.mkdirSync(path.join(setup.prefix, "bin"), { recursive: true });
  fs.writeFileSync(setup.cliPath, "unowned\n", { mode: 0o755 });
  const { discoverCLI } = await import("../scripts/setup/packages.mjs");
  await assert.rejects(discoverCLI(setup.runtime, {}), { code: "unowned_cli" });
});

test("child package tools do not inherit the outer npx runner's package selection", async () => {
  const { runProcess } = await import("../scripts/setup/process.mjs");
  const execution = await runProcess(process.execPath, ["-e", "console.log(JSON.stringify({package:process.env.npm_config_package,upper:process.env.NPM_CONFIG_PACKAGE,home:process.env.HOME}))"], {
    env: { ...process.env, npm_config_package: "@lyy-gh/memocap@0.1.0", NPM_CONFIG_PACKAGE: "@lyy-gh/memocap@0.1.0", HOME: "/sandbox-home" },
  });
  assert.equal(execution.code, 0);
  assert.deepEqual(JSON.parse(execution.stdout), { home: "/sandbox-home" });
});
