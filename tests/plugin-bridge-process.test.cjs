"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const version = require("../package.json").version;
const { fixture, success, waitForFile, assertGone } = require("./plugin-bridge-fixtures.cjs");

test("file readiness waits for publication when the external file initially exists empty", async (context) => {
  const { directory } = await fixture(context, success);
  const file = path.join(directory, "published-pid");
  const published = String(process.pid);
  fs.writeFileSync(file, "");

  const ready = waitForFile(file);
  fs.writeFileSync(file, published);

  assert.equal(await ready, published);
});

test("stdout and stderr overflow terminate the child with bounded captured output", async (context) => {
  for (const stream of ["stdout", "stderr"]) {
    const { directory, run } = await fixture(context, `
      require("node:fs").writeFileSync("pid", String(process.pid));
      setInterval(() => process.${stream}.write("x".repeat(65536)), 1);
    `);
    await assert.rejects(run(["recall", "query"], { cwd: directory }), (error) => {
      assert.equal(error.code, "output_limit");
      assert.ok(Buffer.byteLength(error[stream]) <= 1024 * 1024);
      return true;
    });
    await assertGone(Number(fs.readFileSync(path.join(directory, "pid"), "utf8")));
  }
});

test("an output limit cutting a multibyte character still bounds decoded bytes", async (context) => {
  const { directory, run } = await fixture(context, `
    process.stdout.write(Buffer.concat([Buffer.alloc(1024 * 1024 - 1, 97), Buffer.from("€".repeat(100))]));
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(run(["recall", "query"], { cwd: directory }), (error) => {
    assert.equal(error.code, "output_limit");
    assert.ok(Buffer.byteLength(error.stdout) <= 1024 * 1024);
    return true;
  });
});

test("cancel kills a launcher and its actual nested sidecar without replaying remember", async (context) => {
  const { directory, run } = await fixture(context, `
    const fs = require("node:fs");
    fs.appendFileSync("attempts", "write\\n");
    fs.writeFileSync("launcher-pid", String(process.pid));
    require("node:child_process").spawnSync(process.execPath, ["-e",
      'require("node:fs").writeFileSync("nested-pid", String(process.pid)); setInterval(() => {}, 1000);'], {stdio:"inherit"});
  `);
  const controller = new AbortController();
  const pending = run(["remember", "content"], { cwd: directory, signal: controller.signal });
  const rejected = assert.rejects(pending, (error) => error.code === "cancelled" && error.outcome === "outcome_unknown");
  try {
    const nestedPid = Number(await waitForFile(path.join(directory, "nested-pid")));
    const launcherPid = Number(await waitForFile(path.join(directory, "launcher-pid")));
    assert.ok(Number.isSafeInteger(nestedPid) && nestedPid > 0);
    assert.ok(Number.isSafeInteger(launcherPid) && launcherPid > 0);
    controller.abort();
    await rejected;
    await assertGone(nestedPid);
    await assertGone(launcherPid);
    const attempts = fs.readFileSync(path.join(directory, "attempts"), "utf8");
    assert.equal(attempts, "write\n");
    context.diagnostic(JSON.stringify({ launcherPid, nestedPid, bothGone: true,
      code: "cancelled", outcome: "outcome_unknown", attempts }));
  } finally {
    controller.abort();
    try { await rejected; } finally {
      for (const name of ["nested-pid", "launcher-pid"]) {
        const file = path.join(directory, name);
        if (!fs.existsSync(file)) continue;
        const pid = Number(fs.readFileSync(file, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        try { process.kill(pid, "SIGKILL"); } catch (error) {
          assert.equal(error.code, "ESRCH");
        }
      }
    }
  }
});

test("deadline covers both handshake and command and kills an uncooperative process", async (context) => {
  const { directory, run } = await fixture(context, `
    require("node:fs").writeFileSync("pid", String(process.pid));
    process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);
  `);
  const started = Date.now();
  await assert.rejects(run(["remember", "content"], { cwd: directory, deadlineMs: 500 }),
    (error) => error.code === "timeout" && error.outcome === "outcome_unknown");
  assert.ok(Date.now() - started < 2500);
  await assertGone(Number(fs.readFileSync(path.join(directory, "pid"), "utf8")));
  const slowHandshake = await fixture(context, success, `setInterval(() => {}, 1000)`);
  await assert.rejects(slowHandshake.run(["remember", "content"], { cwd: directory, deadlineMs: 150 }),
    (error) => error.code === "timeout" && error.phase === "handshake" && error.outcome === "not_started");
});

test("default deadline is three seconds and pre-abort never starts a child", async (context) => {
  const { directory, run } = await fixture(context, `setInterval(() => {}, 1000);`);
  const started = Date.now();
  await assert.rejects(run(["recall", "query"], { cwd: directory }), { code: "timeout" });
  assert.ok(Date.now() - started >= 2800);
  assert.ok(Date.now() - started < 5000);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(["remember", "content"], { cwd: directory, signal: controller.signal }),
    (error) => error.code === "cancelled" && error.outcome === "not_started");
});

test("handshake time is deducted from the command deadline", async (context) => {
  const { directory, run } = await fixture(context, `
    require("node:fs").writeFileSync("command-started", "yes");
    ${success}
  `, `
    require("node:fs").writeFileSync("handshake-completed", String(process.pid));
    console.log("memocap ${version}");
  `);
  const handshakeCompleted = path.join(directory, "handshake-completed");
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = context.mock.method(Date, "now", () => fs.existsSync(handshakeCompleted) ? 600 : 0);
  try {
    await assert.rejects(run(["recall", "query"], { cwd: directory, deadlineMs: 600 }),
      { code: "timeout", phase: "command", outcome: "not_started" });
    assert.equal(fs.existsSync(handshakeCompleted), true);
    assert.equal(fs.existsSync(path.join(directory, "command-started")), false);
  } finally {
    clock.mock.restore();
    context.mock.timers.reset();
  }
  await assertGone(Number(fs.readFileSync(handshakeCompleted, "utf8")));
});
