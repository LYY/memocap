"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

function runDriver(context, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "process exit "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const execution = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { runProcess } from "./scripts/setup/process.mjs";
    ${source}
  `], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }, encoding: "utf8", timeout: 30_000 });
  assert.equal(execution.error, undefined, execution.error?.message);
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(fs.readdirSync(root), []);
}

test("Darwin concurrent force-exiting oversized producers reject output and clean capture", { skip: process.platform !== "darwin" }, (context) => {
  runDriver(context, `
    for (let batch = 0; batch < 8; batch++) {
      await Promise.all(Array.from({ length: 8 }, async () => {
        const execution = await runProcess(process.execPath, ["-e", 'require("node:fs").writeSync(1,Buffer.alloc(4000001,120));process.exit(0)'], { stdoutFile: true });
        assert.equal(execution.code, 1);
        assert.equal(execution.stdout, "");
      }));
    }
  `);
});

for (const trigger of ["timeout", "stdout"]) {
  test(`POSIX ${trigger} kills a termination-resistant descendant after its leader exits`, { skip: process.platform === "win32" }, (context) => {
    const descendant = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      process.on("disconnect", () => { ${trigger === "stdout" ? "fs.writeSync(1, Buffer.alloc(4000001));" : ""} });
      console.error("descendant-ready");
      process.send("ready");
      setInterval(() => process.stderr.write("."), 25);
      setTimeout(() => process.exit(99), 15000);
    `;
    const leader = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", 1, 2, "ipc"] });
      child.once("message", () => process.exit(0));
    `;
    runDriver(context, `
      const started = Date.now();
      const execution = await runProcess(process.execPath, ["-e", ${JSON.stringify(leader)}], { stdoutFile: true, timeout: ${trigger === "timeout" ? 1000 : 10000} });
      assert.equal(execution.code, 1);
      assert.equal(execution.stdout, "");
      assert.match(execution.stderr, /descendant-ready/);
      assert.ok(Date.now() - started < 5000, "inherited stderr closes after group termination");
    `);
  });
}

for (const phase of ["initial", "reaped", "force"]) {
  test(`persistent group EPERM during ${phase} termination rejects and removes capture`, { skip: process.platform === "win32" || (phase === "reaped" && process.platform !== "darwin") }, (context) => {
    const producer = 'process.on("SIGTERM",()=>{}); process.on("SIGUSR1",()=>process.exit(0)); require("node:fs").writeSync(1,Buffer.alloc(4000001)); setInterval(()=>{},1000);';
    runDriver(context, `
      const realKill = process.kill.bind(process);
      let groupPid;
      let first = true;
      process.once("uncaughtException", (error) => {
        if (groupPid) realKill(-groupPid, "SIGKILL");
        console.error(error);
        process.exit(1);
      });
      process.kill = (pid, signal) => {
        if (pid >= 0) return realKill(pid, signal);
        groupPid = -pid;
        if (first) {
          first = false;
          realKill(groupPid, 0);
          ${phase === "reaped" ? 'realKill(groupPid, "SIGUSR1");' : ""}
        }
        ${phase === "force" ? 'if (signal === "SIGTERM") return realKill(pid, signal);' : ""}
        throw Object.assign(new Error("group permission denied"), { code: "EPERM" });
      };
      const started = Date.now();
      try {
        await assert.rejects(runProcess(process.execPath, ["-e", ${JSON.stringify(producer)}], { stdoutFile: true, timeout: 5000 }), { code: "EPERM" });
        assert.ok(Date.now() - started < 3000, "permission rejection remains bounded");
        assert.deepEqual(fs.readdirSync(process.env.TMPDIR), []);
      } finally {
        process.kill = realKill;
        if (groupPid) {
          try { realKill(groupPid, 0); realKill(-groupPid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      }
    `);
  });
}

test("Darwin retries a transient group EPERM after reaping the leader", { skip: process.platform !== "darwin" }, (context) => {
  const producer = 'process.on("SIGUSR1",()=>process.exit(0)); require("node:fs").writeSync(1,Buffer.alloc(4000001)); setInterval(()=>{},1000);';
  runDriver(context, `
    const realKill = process.kill.bind(process);
    let groupPid;
    process.once("uncaughtException", (error) => {
      if (groupPid) realKill(-groupPid, "SIGKILL");
      console.error(error);
      process.exit(1);
    });
    process.kill = (pid, signal) => {
      if (pid < 0 && groupPid === undefined) {
        groupPid = -pid;
        realKill(groupPid, "SIGUSR1");
        throw Object.assign(new Error("transient group permission denied"), { code: "EPERM" });
      }
      return realKill(pid, signal);
    };
    try {
      const execution = await runProcess(process.execPath, ["-e", ${JSON.stringify(producer)}], { stdoutFile: true, timeout: 5000 });
      assert.equal(execution.code, 1);
      assert.equal(execution.stdout, "");
      assert.throws(() => realKill(groupPid, 0), { code: "ESRCH" });
    } finally {
      process.kill = realKill;
      if (groupPid) {
        try { realKill(groupPid, 0); realKill(-groupPid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
  `);
});
