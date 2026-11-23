"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const version = require("../package.json").version;
const bridgeModule = import("../plugin/bridge.js");

async function fixture(context, body, handshake = `console.log("memocap ${version}")`) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memocap bridge "));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const launcher = path.join(directory, "fake launcher.cjs");
  fs.writeFileSync(launcher, `if (process.argv[2] === "--version") { ${handshake}; } else { ${body}\n }`);
  const { createBridge } = await bridgeModule;
  return { directory, launcher, run: createBridge({ launcher }).run };
}

const success = `console.log(JSON.stringify({format_version:1,status:"empty",targets:[],results:[]}));`;

async function waitForFile(file) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      if (text.length > 0) return text;
    }
    await delay(10);
  }
  assert.fail(`child did not become ready: ${file}`);
}

async function assertGone(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `expected a positive PID: ${pid}`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(10);
  }
  assert.fail(`child still running: ${pid}`);
}

module.exports = { fixture, success, waitForFile, assertGone };
