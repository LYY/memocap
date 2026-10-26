"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");
const { snapshot } = require("./packaged-runtime.cjs");

for (const layout of ["global", "local"]) test(`readonly host metadata follows the official ${layout} npm native target`, async (context) => {
  const setup = fixture(context);
  const { prerequisites } = await import("../scripts/setup/packages.mjs");
  const modules = path.join(setup.root, "tools with spaces", "node_modules");
  const directory = layout === "global" ? path.dirname(modules) : path.join(modules, ".bin");
  const packageRoot = path.join(modules, "opencode-ai");
  const metadata = path.join(packageRoot, "package.json");
  const launcher = path.join(directory, "opencode.cmd");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(packageRoot, "bin/opencode.exe"));
  fs.writeFileSync(metadata, JSON.stringify({ name: "opencode-ai", version: "1.19.3", bin: { opencode: "./bin/opencode.exe" } }));
  fs.writeFileSync(launcher, "@echo off\r\n", { mode: 0o755 });
  const runtime = { ...setup.runtime, env: { ...setup.env, PATH: directory }, platform: "win32", arch: "x64",
    run: () => assert.fail("readonly host inspection must not execute a child") };
  const before = snapshot([setup.root]);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const observed = await prerequisites(runtime);
    assert.equal(observed.opencode, "1.19.3");
    assert.deepEqual(observed.host, { executable_path: launcher, version: "1.19.3", source: fs.realpathSync(metadata) });
    assert.deepEqual(snapshot([setup.root]), before);
  } finally { Object.defineProperty(process, "platform", platform); }
});

for (const target of ["unknown", "missing", "directory"]) test(`readonly ${target} shim target stays unverified even under host metadata`, async (context) => {
  const setup = fixture(context);
  const { inspectHost } = await import("../scripts/setup/host.mjs");
  const directory = path.join(setup.root, "unverified host");
  const launcher = path.join(directory, "opencode.cmd");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "opencode-ai", version: "1.19.3" }));
  fs.writeFileSync(launcher, target === "unknown" ? ":: cmd-shim-target=relative.exe\r\n" : "@echo off\r\n", { mode: 0o755 });
  if (target === "directory") fs.mkdirSync(path.join(directory, "node_modules/opencode-ai/bin/opencode.exe"), { recursive: true });
  const runtime = { ...setup.runtime, env: { ...setup.env, PATH: directory },
    run: () => assert.fail("unverified host inspection must not execute a child") };
  const before = snapshot([setup.root]);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const observed = inspectHost(runtime);
    assert.equal(observed.executable_path, launcher);
    assert.equal(observed.version, null);
    assert.equal(observed.source, "not_run");
    assert.deepEqual(snapshot([setup.root]), before);
  } finally { Object.defineProperty(process, "platform", platform); }
});

for (const origin of ["native", "homebrew"]) test(`readonly ${origin} host keeps package or receipt metadata without execution`, async (context) => {
  const setup = fixture(context);
  const { inspectHost } = await import("../scripts/setup/host.mjs");
  const directory = path.join(setup.root, "installed host");
  const binary = path.join(directory, "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.copyFileSync(process.execPath, binary);
  fs.chmodSync(binary, 0o755);
  const metadata = path.join(directory, origin === "homebrew" ? "INSTALL_RECEIPT.json" : "package.json");
  fs.writeFileSync(metadata, JSON.stringify(origin === "homebrew"
    ? { source: { tap: "anomalyco/tap", path: "Formula/opencode.rb", versions: { stable: "1.19.3" } } }
    : { name: "opencode-ai", version: "1.19.3" }));
  const launcher = binary;
  const runtime = { ...setup.runtime, env: { ...setup.env, PATH: path.dirname(launcher) },
    run: () => assert.fail("metadata inspection must not execute a child") };
  const before = snapshot([setup.root]);
  const observed = inspectHost(runtime);
  assert.deepEqual(observed, { executable_path: launcher, version: "1.19.3", source: fs.realpathSync(metadata) });
  assert.deepEqual(snapshot([setup.root]), before);
});

for (const origin of ["native", "homebrew"]) test(`readonly ${origin} metadata does not require readable executable bytes`, { skip: process.platform === "win32" }, async (context) => {
  const setup = fixture(context);
  const { inspectHost } = await import("../scripts/setup/host.mjs");
  const directory = path.join(setup.root, "executable only host");
  const binary = path.join(directory, "bin/opencode");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.copyFileSync(process.execPath, binary);
  const metadata = path.join(directory, origin === "homebrew" ? "INSTALL_RECEIPT.json" : "package.json");
  fs.writeFileSync(metadata, JSON.stringify(origin === "homebrew"
    ? { source: { tap: "anomalyco/tap", path: "Formula/opencode.rb", versions: { stable: "1.19.3" } } }
    : { name: "opencode-ai", version: "1.19.3" }));
  const before = snapshot([setup.root]);
  fs.chmodSync(binary, 0o111);
  const runtime = { ...setup.runtime, env: { ...setup.env, PATH: path.dirname(binary) },
    run: () => assert.fail("metadata inspection must not execute a child") };
  try {
    assert.throws(() => fs.readFileSync(binary), { code: "EACCES" });
    assert.deepEqual(inspectHost(runtime), { executable_path: binary, version: "1.19.3", source: fs.realpathSync(metadata) });
  } finally { fs.chmodSync(binary, 0o755); }
  assert.deepEqual(snapshot([setup.root]), before);
});

test("readonly prerequisites reject an unsupported native package version without execution", async (context) => {
  const setup = fixture(context);
  const { prerequisites } = await import("../scripts/setup/packages.mjs");
  const directory = path.join(setup.root, "unsupported host");
  const modules = path.join(directory, "node_modules/opencode-ai");
  fs.mkdirSync(path.join(modules, "bin"), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(modules, "bin/opencode.exe"));
  fs.writeFileSync(path.join(modules, "package.json"), JSON.stringify({ name: "opencode-ai", version: "1.19.2" }));
  fs.writeFileSync(path.join(directory, "opencode.cmd"), "@echo off\r\n", { mode: 0o755 });
  const runtime = { ...setup.runtime, env: { ...setup.env, PATH: directory }, platform: "win32", arch: "x64",
    run: () => assert.fail("unsupported host inspection must not execute a child") };
  const before = snapshot([setup.root]);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await assert.rejects(prerequisites(runtime), { code: "unsupported_host" });
    assert.deepEqual(snapshot([setup.root]), before);
  } finally { Object.defineProperty(process, "platform", platform); }
});
