"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
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

test("literal argv, explicit cwd and receipt warnings survive the process boundary", async (context) => {
  const { directory, run } = await fixture(context, `
    console.error("activity degraded");
    console.log(JSON.stringify({format_version:1,package_version:${JSON.stringify(version)},
      status:"inserted",activity_status:"failed",warnings:["activity unavailable"],
      targets:[],results:[],argv:process.argv.slice(2),cwd:process.cwd()}));
  `);
  const marker = path.join(directory, "shell-executed");
  const argv = ["remember", "two words", "quote\"'", `$(touch '${marker}')`, "line1\nline2", "", "%PATH%", "& echo bad"];
  const { receipt, stderr, exitCode } = await run(argv, { cwd: directory });
  assert.deepEqual(receipt.argv, [...argv, "--json"]);
  assert.equal(fs.realpathSync(receipt.cwd), fs.realpathSync(directory));
  assert.equal(receipt.status, "inserted");
  assert.equal(receipt.activity_status, "failed");
  assert.deepEqual(receipt.warnings, ["activity unavailable"]);
  assert.equal(stderr, "activity degraded\n");
  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(marker), false);
});

test("default launcher resolves relative to its own package even from another cwd", async (context) => {
  const { directory, launcher } = await fixture(context, success);
  const packageRoot = path.join(directory, "package with spaces");
  fs.mkdirSync(path.join(packageRoot, "plugin"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "bin"));
  fs.copyFileSync(path.join(__dirname, "../plugin/bridge.js"), path.join(packageRoot, "plugin/bridge.js"));
  fs.copyFileSync(launcher, path.join(packageRoot, "bin/cli.cjs"));
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ type: "module", version }));
  const { run } = await import(pathToFileURL(path.join(packageRoot, "plugin/bridge.js")));
  assert.equal((await run(["recall", "query"], { cwd: directory })).receipt.status, "empty");
});

test("compiled Bun host launches the bundled CLI through verified Node rather than its host executable", async (context) => {
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8", shell: false, timeout: 3000 });
  if (bun.error?.code === "ENOENT") { context.skip("Bun compiler unavailable"); return; }
  assert.equal(bun.status, 0, bun.stderr);
  const { directory, launcher } = await fixture(context, `
    console.log(JSON.stringify({format_version:1,status:"empty",runtime:process.release.name,
      node:process.versions.node,bun:process.versions.bun ?? null}));
  `);
  const source = path.join(directory, "host.js");
  const executable = path.join(directory, process.platform === "win32" ? "host.exe" : "host");
  fs.writeFileSync(source, `
    if (process.argv.includes("--version")) { console.log("1.19.3"); process.exit(0); }
    const moduleURL = ${JSON.stringify(pathToFileURL(path.resolve(__dirname, "../plugin/bridge.js")).href)};
    const { createBridge } = await import(moduleURL);
    const { receipt } = await createBridge({launcher:${JSON.stringify(launcher)}}).run(["recall", "literal"],
      {cwd:${JSON.stringify(directory)}});
    console.log(JSON.stringify({receipt,host:process.execPath,bun:process.versions.bun}));
  `);
  const build = spawnSync("bun", ["build", "--compile", source, "--outfile", executable], { encoding: "utf8", shell: false, timeout: 20000 });
  assert.equal(build.status, 0, build.stderr);
  const executed = spawnSync(executable, [], { encoding: "utf8", shell: false, timeout: 10000 });
  assert.equal(executed.status, 0, executed.stderr);
  const observed = JSON.parse(executed.stdout);
  assert.equal(fs.realpathSync(observed.host), fs.realpathSync(executable));
  assert.ok(observed.bun);
  assert.equal(observed.receipt.runtime, "node");
  assert.equal(observed.receipt.bun, null);
});

test("a non-Node executable and Windows shell shims fail before the requested write", async (context) => {
  const { directory, launcher } = await fixture(context, `require("node:fs").writeFileSync("write-started", "yes");`);
  const { createBridge } = await bridgeModule;
  const incompatible = path.join(directory, "not-node.cjs");
  fs.writeFileSync(incompatible, '#!/usr/bin/env node\nconsole.log(JSON.stringify({release:"node",node:"22.19.9",execPath:process.execPath}));\n');
  fs.chmodSync(incompatible, 0o755);
  if (process.platform !== "win32") {
    await assert.rejects(createBridge({ launcher, executable: incompatible }).run(["remember", "literal"], { cwd: directory }),
      { code: "runtime_incompatible" });
    fs.writeFileSync(incompatible, '#!/usr/bin/env node\nconsole.log(JSON.stringify({release:"node",node:22,execPath:process.execPath}));\n');
    await assert.rejects(createBridge({ launcher, executable: incompatible }).run(["remember", "literal"], { cwd: directory }),
      { code: "runtime_incompatible" });
  }
  for (const suffix of [".cmd", ".BAT"]) {
    assert.throws(() => createBridge({ launcher, executable: path.join(directory, `node${suffix}`) }), { code: "invalid_request" });
  }
  assert.equal(fs.existsSync(path.join(directory, "write-started")), false);
});

test("missing launcher and missing executable are visibly typed before mutation", async (context) => {
  const { directory, launcher } = await fixture(context, success);
  const { createBridge } = await bridgeModule;
  for (const [options, code] of [
    [{ launcher: path.join(directory, "missing.cjs") }, "launcher_missing"],
    [{ launcher, executable: path.join(directory, "missing-node") }, "spawn_failed"],
  ]) {
    await assert.rejects(createBridge(options).run(["remember", "content"], { cwd: directory }),
      (error) => error.code === code && error.outcome === "not_started");
  }
});

test("wrong handshake version prevents the requested write from starting", async (context) => {
  const { directory, run } = await fixture(context, `require("node:fs").writeFileSync("write-started", "yes");`,
    `console.log("memocap 999.0.0")`);
  await assert.rejects(run(["remember", "content"], { cwd: directory }),
    (error) => error.code === "version_mismatch" && error.phase === "handshake" && error.outcome === "not_started");
  assert.equal(fs.existsSync(path.join(directory, "write-started")), false);
});

test("JSON package version is checked even after a successful handshake", async (context) => {
  const { directory, run } = await fixture(context,
    `console.log(JSON.stringify({format_version:1,status:"ok",package_version:"999.0.0"}));`);
  await assert.rejects(run(["recall", "query"], { cwd: directory }), { code: "version_mismatch" });
});

test("malformed JSON and incompatible envelopes are protocol failures", async (context) => {
  for (const stdout of ["not json", "{}", "null", "[]", '{"format_version":2,"status":"ok"}',
    '{"format_version":1,"status":""}', '{"format_version":1,"status":"ok","results":{}}']) {
    const { directory, run } = await fixture(context, `process.stdout.write(${JSON.stringify(stdout)});`);
    await assert.rejects(run(["remember", "content"], { cwd: directory }),
      (error) => error.code === "invalid_receipt" && error.outcome === "outcome_unknown");
  }
});

test("nonzero CLI retains the failed receipt and diagnostics", async (context) => {
  const { directory, run } = await fixture(context, `
    console.error("remote refused");
    console.log(JSON.stringify({format_version:1,status:"rejected",error:{code:"denied"},warnings:["remote"]}));
    process.exitCode = 2;
  `);
  await assert.rejects(run(["remember", "content"], { cwd: directory }), (error) => {
    assert.equal(error.code, "cli_failed");
    assert.equal(error.exitCode, 2);
    assert.equal(error.stderr, "remote refused\n");
    assert.equal(error.receipt.status, "rejected");
    assert.deepEqual(error.receipt.warnings, ["remote"]);
    assert.equal(error.outcome, "rejected");
    return true;
  });
});

test("nonzero CLI with plain diagnostics stays a CLI failure", async (context) => {
  const { directory, run } = await fixture(context, `console.error("missing dependency"); process.exitCode = 1;`);
  await assert.rejects(run(["recall", "query"], { cwd: directory }),
    (error) => error.code === "cli_failed" && error.stderr.includes("missing dependency"));
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

async function waitForFile(file) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    await delay(10);
  }
  assert.fail(`child did not become ready: ${file}`);
}

async function assertGone(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(10);
  }
  assert.fail(`child still running: ${pid}`);
}

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
  const nestedPid = Number(await waitForFile(path.join(directory, "nested-pid")));
  controller.abort();
  await rejected;
  await assertGone(nestedPid);
  await assertGone(Number(fs.readFileSync(path.join(directory, "launcher-pid"), "utf8")));
  assert.equal(fs.readFileSync(path.join(directory, "attempts"), "utf8"), "write\n");
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
    setTimeout(() => { ${success} }, 350);
  `, `setTimeout(() => console.log("memocap ${version}"), 300)`);
  const started = Date.now();
  await assert.rejects(run(["recall", "query"], { cwd: directory, deadlineMs: 600 }), { code: "timeout" });
  assert.equal(fs.existsSync(path.join(directory, "command-started")), true);
  assert.ok(Date.now() - started < 850);
});

test("invalid argv, cwd and deadline reject before launching", async (context) => {
  const { run, directory } = await fixture(context, success);
  for (const [argv, options] of [["recall", { cwd: directory }], [["recall", 1], { cwd: directory }],
    [["recall", "\0"], { cwd: directory }], [["recall"], {}], [["recall"], { cwd: "" }],
    [["recall"], { cwd: directory, deadlineMs: -1 }]]) {
    await assert.rejects(run(argv, options), { code: "invalid_request" });
  }
});
