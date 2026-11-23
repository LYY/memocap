"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const version = require("../package.json").version;
const bridgeModule = import("../plugin/bridge.js");

const { fixture, success, waitForFile } = require("./plugin-bridge-fixtures.cjs");

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

test("a withdrawn candidate during a delayed handshake never starts the command", async (context) => {
  const { directory, run } = await fixture(context,
    `require('node:fs').writeFileSync('command-started', 'yes'); ${success}`, `
    require('node:fs').writeFileSync('handshake-started', 'yes');
    const timer = setInterval(() => {
      if (require('node:fs').existsSync('release-handshake')) {
        clearInterval(timer); console.log('memocap ${version}');
      }
    }, 5);
  `);
  let valid = true;
  let barriers = 0;
  const pending = run(['remember', 'withdrawn'], { cwd: directory, beforeSpawn() {
    barriers++;
    if (!valid) throw Object.assign(new Error('withdrawn'), { code: 'cancelled', outcome: 'outcome_unknown' });
  } });
  const rejected = assert.rejects(pending, { code: 'cancelled', phase: 'command', outcome: 'not_started' });
  await waitForFile(path.join(directory, 'handshake-started'));
  valid = false;
  fs.writeFileSync(path.join(directory, 'release-handshake'), 'yes');
  await rejected;
  assert.equal(barriers, 1);
  assert.equal(fs.existsSync(path.join(directory, 'command-started')), false);
});

test("beforeSpawn runs only for a command after a successful handshake", async (context) => {
  let barriers = 0;
  const beforeSpawn = () => { barriers++; };
  const failed = await fixture(context, success, `console.log('memocap 999.0.0')`);
  await assert.rejects(failed.run(['remember', 'body'], { cwd: failed.directory, beforeSpawn }), { code: 'version_mismatch' });
  assert.equal(barriers, 0);
  const accepted = await fixture(context, success);
  await accepted.run(['remember', 'body'], { cwd: accepted.directory, beforeSpawn });
  assert.equal(barriers, 1);
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

test("invalid argv, cwd and deadline reject before launching", async (context) => {
  const { run, directory } = await fixture(context, success);
  for (const [argv, options] of [["recall", { cwd: directory }], [["recall", 1], { cwd: directory }],
    [["recall", "\0"], { cwd: directory }], [["recall"], {}], [["recall"], { cwd: "" }],
    [["recall"], { cwd: directory, deadlineMs: -1 }]]) {
    await assert.rejects(run(argv, options), { code: "invalid_request" });
  }
});

test("optional stdin carries literal UTF8 to EOF under a copied environment without argv disclosure", async (context) => {
  const { directory, run } = await fixture(context, `
    let raw = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => raw += chunk);
    process.stdin.on('end', () => console.log(JSON.stringify({format_version:1,status:'ok',
      stdin:raw,argv:process.argv.slice(2),database:process.env.MEMOCAP_DB})));
  `);
  const stdin = JSON.stringify({ content: 'literal $(touch forbidden)\n中文 "quote"' });
  const { receipt } = await run(['organize', 'apply'], { cwd: directory, stdin,
    env: { ...process.env, MEMOCAP_DB: '/frozen/db' } });
  assert.equal(receipt.stdin, stdin);
  assert.equal(receipt.database, '/frozen/db');
  assert.deepEqual(receipt.argv, ['organize', 'apply', '--json']);
});
