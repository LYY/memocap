"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { syncBuiltinESMExports } = require("node:module");
const childProcess = require("node:child_process");
const test = require("node:test");

const pluginPath = path.resolve(__dirname, "../plugin/cli.js");

let importCounter = 0;

function loadPlugin() {
  importCounter += 1;
  return import(`${pathToFileURL(pluginPath).href}?test=${importCounter}`);
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o755 });
}

async function withEnvironment(values, action) {
  const original = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    return await action();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("plugin run invokes the global launcher on PATH from explicit project cwd", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-plugin-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const projectDir = path.join(tempDir, "project");
  fs.mkdirSync(projectDir);
  if (process.platform === "win32") {
    const launcher = path.join(tempDir, "global-cli.cjs");
    fs.writeFileSync(launcher, `process.stdout.write(process.cwd() + "\\n" + process.argv.slice(2).join(" "));`);
    fs.writeFileSync(
      path.join(tempDir, "memocap.cmd"),
      `@echo off\r\n"%~dp0global-cli.cjs" %*\r\n`,
    );
  } else {
    writeExecutable(
      path.join(tempDir, "memocap"),
      `process.stdout.write(process.cwd() + "\\n" + process.argv.slice(2).join(" "));`,
    );
  }

  await withEnvironment(
    { PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}` },
    async () => {
      const { run } = await loadPlugin();

      const [observedCwd, observedArgs] = run(["recall", "memory"], projectDir).split("\n");
      assert.equal(fs.realpathSync(observedCwd), fs.realpathSync(projectDir));
      assert.equal(observedArgs, "recall memory");
    },
  );
});

test("plugin run rejects missing cwd before spawning a sidecar", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-plugin-missing-cwd-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const marker = path.join(tempDir, "spawned");
  writeExecutable(path.join(tempDir, "memocap"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");`);

  await withEnvironment(
    { PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}` },
    async () => {
      const { run } = await loadPlugin();

      assert.throws(() => run(["recall", "memory"]), /project directory/);
      assert.equal(fs.existsSync(marker), false);
    },
  );
});

test("plugin run rejects empty cwd before spawning a sidecar", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-plugin-empty-cwd-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const marker = path.join(tempDir, "spawned");
  writeExecutable(path.join(tempDir, "memocap"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");`);

  await withEnvironment(
    { PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}` },
    async () => {
      const { run } = await loadPlugin();

      assert.throws(() => run(["recall", "memory"], ""), /project directory/);
      assert.equal(fs.existsSync(marker), false);
    },
  );
});

test("plugin run applies explicit cwd to Windows lookup and final launcher", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-plugin-windows-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const projectDir = path.join(tempDir, "project");
  const shim = path.join(tempDir, "memocap.cmd");
  fs.mkdirSync(projectDir);
  fs.writeFileSync(shim, `@echo off\r\n"%~dp0global-cli.cjs" %*\r\n`);

  const calls = [];
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  context.mock.method(childProcess, "spawnSync", (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "where.exe") {
      return { status: 0, stdout: `${shim}\r\n`, stderr: "" };
    }
    return { status: 0, stdout: "global output\n", stderr: "" };
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  context.after(() => {
    Object.defineProperty(process, "platform", platform);
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const { run } = await loadPlugin();

  assert.equal(run(["recall", "memory"], projectDir), "global output\n");
  assert.deepEqual(calls, [
    {
      command: "where.exe",
      args: ["memocap.cmd"],
      options: { cwd: projectDir, encoding: "utf8", windowsHide: true },
    },
    {
      command: process.execPath,
      args: [path.join(tempDir, "global-cli.cjs"), "recall", "memory"],
      options: { cwd: projectDir, encoding: "utf8" },
    },
  ]);
});

test("compaction injects memory rules without executing a sidecar", async (context) => {
  const calls = [];
  context.mock.method(childProcess, "spawnSync", (...args) => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  });
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const { RULES, memocap } = await loadPlugin();
  const plugin = await memocap({ directory: "/tmp/project" });
  const output = { context: [] };

  await plugin["experimental.session.compacting"]({}, output);

  assert.deepEqual(output.context, [RULES]);
  assert.deepEqual(calls, []);
});
