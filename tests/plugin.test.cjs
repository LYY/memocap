"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const pluginPath = path.resolve(__dirname, "../plugin/cli.js");

test("plugin run invokes the global launcher on PATH", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-plugin-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const bypassBinary = path.join(tempDir, "bypass.cjs");
  fs.writeFileSync(bypassBinary, `#!${process.execPath}\nprocess.stdout.write("package output\\n");`, {
    mode: 0o755,
  });
  if (process.platform === "win32") {
    const launcher = path.join(tempDir, "global-cli.cjs");
    fs.writeFileSync(launcher, `process.stdout.write("global output\\n");`);
    fs.writeFileSync(
      path.join(tempDir, "memocap.cmd"),
      `@echo off\r\n"%~dp0global-cli.cjs" %*\r\n`,
    );
  } else {
    fs.writeFileSync(
      path.join(tempDir, "memocap"),
      `#!${process.execPath}\nprocess.stdout.write("global output\\n");`,
      { mode: 0o755 },
    );
  }

  const originalBinary = process.env.MEMOCAP_BINARY;
  const originalPath = process.env.PATH;
  process.env.MEMOCAP_BINARY = bypassBinary;
  process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
  try {
    const { run } = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);

    assert.equal(run(["recall", "memory"]), "global output\n");
  } finally {
    if (originalBinary === undefined) delete process.env.MEMOCAP_BINARY;
    else process.env.MEMOCAP_BINARY = originalBinary;
    process.env.PATH = originalPath;
  }
});
