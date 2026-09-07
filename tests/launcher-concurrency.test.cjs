"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const launcherPath = path.resolve(__dirname, "../bin/cli.cjs");
const { createCacheLock } = require("../bin/cache-lock.cjs");
const { verifyCachedBinary } = require(launcherPath);

const assets = {
  "linux-x64": "memocap-x86_64-unknown-linux-gnu",
  "darwin-arm64": "memocap-aarch64-apple-darwin",
  "win32-x64": "memocap-x86_64-pc-windows-msvc.exe",
};

function cacheDirectory(root) {
  const version = require("../package.json").version;
  if (process.platform === "darwin") {
    return path.join(root, "home", "Library", "Caches", "memocap", version);
  }
  if (process.platform === "win32") {
    return path.join(root, "cache", "memocap", version);
  }
  return path.join(root, "cache", "memocap", version);
}

function downloadHook(root) {
  const hook = path.join(root, "download-hook.cjs");
  fs.writeFileSync(
    hook,
    `"use strict";
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const { Readable } = require("node:stream");
const binary = fs.readFileSync(process.env.MEMOCAP_TEST_BINARY);
const manifest = Buffer.from(crypto.createHash("sha256").update(binary).digest("hex") + "  " + process.env.MEMOCAP_TEST_ASSET + "\\n");
https.get = (url, _options, callback) => {
  const body = String(url).endsWith(".sha256") ? manifest : binary;
  const delay = String(url).endsWith(".sha256") ? 0 : process.env.MEMOCAP_TEST_PARTICIPANT === "a" ? 500 : 1000;
  const request = new EventEmitter();
  const response = new Readable({ read() {} });
  response.statusCode = 200;
  response.headers = {};
  process.nextTick(() => {
    callback(response);
    setTimeout(() => {
      response.push(body);
      response.push(null);
    }, delay);
  });
  return request;
};
`,
  );
  return hook;
}

function executableFixture(root) {
  if (process.platform === "win32") {
    return process.execPath;
  }
  const executable = path.join(root, "memocap-test");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return executable;
}

function coldStart(root, hook, asset, participant, executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcherPath, "--version"], {
      env: {
        ...process.env,
        HOME: path.join(root, "home"),
        LOCALAPPDATA: path.join(root, "cache"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        MEMOCAP_TEST_ASSET: asset,
        MEMOCAP_TEST_BINARY: executable,
        MEMOCAP_TEST_PARTICIPANT: participant,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(hook)}`.trim(),
      },
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

test("parallel cold starts publish one verified executable cache", async (context) => {
  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset) {
    context.skip(`unsupported test platform ${process.platform}/${process.arch}`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-launcher-race-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hook = downloadHook(root);
  const executable = executableFixture(root);

  const executions = await Promise.all([
    coldStart(root, hook, asset, "a", executable),
    coldStart(root, hook, asset, "b", executable),
  ]);

  for (const execution of executions) {
    assert.equal(execution.status, 0, execution.stderr);
  }
  const directory = cacheDirectory(root);
  const binary = path.join(directory, asset);
  assert.equal(verifyCachedBinary(binary, `${binary}.sha256`, asset), true);
  assert.deepEqual(fs.readdirSync(directory).sort(), [asset, `${asset}.sha256`].sort());
  if (process.platform !== "win32") {
    assert.notEqual(fs.statSync(binary).mode & 0o111, 0);
  }
});

test("reclaims a cache lease after its owner exits", async (context) => {
  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset) {
    context.skip(`unsupported test platform ${process.platform}/${process.arch}`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-launcher-stale-lock-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(owner.status, 0, owner.stderr);
  assert.ok(owner.pid);
  const directory = cacheDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${asset}.lock.lease-${owner.pid}-stale`),
    JSON.stringify({ pid: owner.pid, processStart: "dead-owner", state: "owner", createdAt: Date.now() }),
  );

  const execution = await coldStart(root, downloadHook(root), asset, "stale", executableFixture(root));

  assert.equal(execution.status, 0, execution.stderr);
  const binary = path.join(directory, asset);
  assert.equal(verifyCachedBinary(binary, `${binary}.sha256`, asset), true);
  assert.deepEqual(fs.readdirSync(directory).sort(), [asset, `${asset}.sha256`].sort());
});

test("parallel contenders reclaim a stale cache lease without deleting its winner", async (context) => {
  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset) {
    context.skip(`unsupported test platform ${process.platform}/${process.arch}`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-launcher-stale-race-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(owner.status, 0, owner.stderr);
  assert.ok(owner.pid);
  const directory = cacheDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${asset}.lock.lease-${owner.pid}-stale`),
    JSON.stringify({ pid: owner.pid, processStart: "dead-owner", state: "owner", createdAt: Date.now() }),
  );
  const hook = downloadHook(root);
  const executable = executableFixture(root);

  const executions = await Promise.all([
    coldStart(root, hook, asset, "a", executable),
    coldStart(root, hook, asset, "b", executable),
  ]);

  for (const execution of executions) {
    assert.equal(execution.status, 0, execution.stderr);
  }
  const binary = path.join(directory, asset);
  assert.equal(verifyCachedBinary(binary, `${binary}.sha256`, asset), true);
  assert.deepEqual(fs.readdirSync(directory).sort(), [asset, `${asset}.sha256`].sort());
});

test("reclaims a lease when its PID belongs to a different process identity", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-launcher-pid-reuse-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "memocap.lock");
  fs.writeFileSync(
    `${lockPath}.lease-${process.pid}-reused`,
    JSON.stringify({
      pid: process.pid,
      processStart: "reused-process",
      state: "owner",
      createdAt: Date.now(),
    }),
  );

  const lock = await createCacheLock(lockPath);

  assert.ok(lock);
  fs.rmSync(lock.path);
});
