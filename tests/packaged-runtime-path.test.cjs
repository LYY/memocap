"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function createRuntime(platform, env) {
  const module = { exports: {} };
  const runtimePath = require.resolve("./packaged-runtime.cjs");
  vm.runInNewContext(fs.readFileSync(runtimePath, "utf8"), {
    module, __dirname, Buffer,
    process: { platform, execPath: "E:\\Node Tools\\node.exe", env },
    require: (name) => {
      if (name === "node:path") return platform === "win32" ? path.win32 : path.posix;
      if (name === "node:fs") return { ...fs, mkdirSync() {} };
      return require(name);
    },
    setTimeout, clearTimeout,
  }, { filename: runtimePath });
  return module.exports;
}

for (const systemRoot of ["C:\\Windows", "D:\\AlternateWindows", "D:\\System Root With Spaces"]) {
  test(`Windows isolation exposes only fixed system tools for ${systemRoot}`, () => {
    const runtime = createRuntime("win32", {
      SystemRoot: systemRoot, ProgramFiles: "E:\\Program Files",
      PATH: "Z:\\Personal Tools;Z:\\PowerShell7", OPENAI_API_KEY: "fixture-secret",
    });

    const env = runtime.isolatedEnvironment("R:\\Sandbox With Spaces");

    assert.deepEqual(env.PATH.split(";"), [
      "E:\\Node Tools", path.win32.join(systemRoot, "System32"), systemRoot,
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
      "E:\\Program Files\\Git\\cmd", "E:\\Program Files\\Git\\usr\\bin",
    ]);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.HOME, "R:\\Sandbox With Spaces\\home");
    assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, "true");
  });
}

for (const platform of ["darwin", "linux"]) {
  test(`${platform} isolation keeps its fixed PATH despite Windows and user environment`, () => {
    const runtime = createRuntime(platform, { SystemRoot: "D:\\Windows", PATH: "/personal/tools" });

    const env = runtime.isolatedEnvironment("/sandbox with spaces");

    assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(env.HOME, "/sandbox with spaces/home");
  });
}

test("runner passes the isolated Windows PATH and explicit override to a real Node child", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap path child "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = createRuntime("win32", { SystemRoot: "D:\\System Root", PATH: "Z:\\Personal" });
  const env = runtime.isolatedEnvironment("R:\\Sandbox");
  const active = new Set();
  const evidence = { commands: [] };
  const run = runtime.runner(env, evidence, active, root);

  const result = await run(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"],
    { env: { TASK25_MARKER: "explicit-child-override" } });

  const childEnv = JSON.parse(result.stdout);
  assert.ok(childEnv.PATH.split(";").includes("D:\\System Root\\System32\\WindowsPowerShell\\v1.0"));
  assert.equal(childEnv.PATH, env.PATH);
  assert.equal(childEnv.TASK25_MARKER, "explicit-child-override");
  assert.equal(childEnv.PATH.includes("Personal"), false);
  assert.equal(active.size, 0);
  assert.equal(evidence.commands.length, 1);
});

test("runner dispatches an executable .exe control with known arguments and rejects a missing executable", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap exe dispatch "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "powershell.exe");
  fs.copyFileSync(process.execPath, executable);
  fs.chmodSync(executable, 0o755);
  const runtime = createRuntime("win32", { SystemRoot: "D:\\System Root" });
  const active = new Set();
  const run = runtime.runner(runtime.isolatedEnvironment("R:\\Sandbox"), { commands: [] }, active, root);

  const result = await run(executable, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "known argument"],
    { env: process.platform === "darwin" ? {
      DYLD_LIBRARY_PATH: path.resolve(path.dirname(process.execPath), "../lib"),
    } : {} });

  assert.deepEqual(JSON.parse(result.stdout), ["known argument"]);
  await assert.rejects(run(path.join(root, "absent.exe"), []), { code: "ENOENT" });
  assert.equal(active.size, 0);
});
