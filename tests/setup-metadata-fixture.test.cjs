"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

test("ordinary fixtures own synchronous metadata callbacks and separate directory receipts", (context) => {
  const first = fixture(context);
  const second = fixture(context);
  assert.equal(typeof first.runtime.policyMetadata, "function");
  assert.equal(typeof second.runtime.policyMetadata, "function");
  assert.notEqual(first.runtime.policyMetadata, second.runtime.policyMetadata);
  assert.notEqual(first.metadataChecks, second.metadataChecks);

  const checked = first.runtime.policyMetadata(first.project);

  assert.equal(checked, null);
  assert.deepEqual(first.metadataChecks, [first.project]);
  assert.deepEqual(second.metadataChecks, []);
  assert.equal(Object.hasOwn(first.runtime, "metadataChecks"), false);
});

test("ordinary setup invokes its callback while executing the installed CLI bytes", async (context) => {
  const f = fixture(context);
  const database = path.join(f.home, ".memocap/memocap.db");

  const installed = await f.setup(["install", "--yes"]);

  assert.equal(installed.exit_code, 0, JSON.stringify(installed));
  assert.ok(Array.isArray(f.metadataChecks), "fixture exposes metadata callback receipts");
  assert.ok(f.metadataChecks.length > 0);
  assert.ok(f.metadataChecks.every((directory) => path.isAbsolute(directory)));
  assert.ok(f.metadataChecks.includes(path.join(f.packageRoot, "skills/memocap")));
  assert.ok(f.metadataChecks.some((directory) => directory.includes(`${path.sep}.memocap-policy-`)));
  assert.ok(f.metadataChecks.includes(f.managedPath()));
  assert.equal(fs.readFileSync(database, "utf8"), "fixture main");
  context.diagnostic(`controlled install metadata callback receipts: ${f.metadataChecks.length}`);

  fs.writeFileSync(path.join(f.installed, "fixture-cli.cjs"), "console.log(JSON.stringify({executed:process.env.FIXTURE_RECEIPT,args:process.argv.slice(2)}));\n");
  const execution = await f.runtime.run(f.cliPath, ["literal argument"], { env: { FIXTURE_RECEIPT: "rewritten CLI" } });
  assert.equal(execution.code, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout), { executed: "rewritten CLI", args: ["literal argument"] });
});

test("a metadata failure override cannot infect another fixture or its receipts", async (context) => {
  const denied = fixture(context);
  const accepted = fixture(context);
  const refusals = [];
  denied.runtime.policyMetadata = (directory) => { refusals.push(directory); throw new Error("fixture metadata refusal"); };

  const failed = await denied.setup(["install", "--yes"]);
  const installed = await accepted.setup(["install", "--yes"]);

  assert.equal(failed.error.code, "policy_reparse_check_failed");
  assert.equal(fs.existsSync(denied.config), false);
  assert.ok(refusals.length > 0);
  assert.deepEqual(denied.metadataChecks, []);
  assert.equal(installed.exit_code, 0, JSON.stringify(installed));
  assert.ok(accepted.metadataChecks.length > 0);
  assert.ok(accepted.metadataChecks.every((directory) => [accepted.root, fs.realpathSync(accepted.root)].some((root) => directory.startsWith(`${root}${path.sep}`))));
  assert.ok(refusals.every((directory) => [denied.root, fs.realpathSync(denied.root)].some((root) => directory.startsWith(`${root}${path.sep}`))));
  context.diagnostic(`isolated callback receipts: accepted=${accepted.metadataChecks.length}, refused=${refusals.length}`);
});

test("fixture command receipts precede hooks, failure injection and real dispatch", async (context) => {
  const f = fixture(context);
  f.installCLI("0.1.0");
  const events = [];
  const marker = path.join(f.root, "executed");
  const launcher = path.join(f.installed, "fixture-cli.cjs");
  f.state.afterCommand = (command, args) => {
    assert.deepEqual(f.calls.at(-1), { command, args, cwd: f.project });
    events.push("afterCommand");
    fs.writeFileSync(launcher, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.FIXTURE_RECEIPT); console.log('real dispatch');\n`);
  };
  f.state.fail = () => { events.push("fail"); return true; };

  const blocked = await f.runtime.run(f.cliPath, ["probe"], { cwd: f.project, env: { FIXTURE_RECEIPT: "received" } });

  assert.equal(blocked.code, 1);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(events, ["afterCommand", "fail"]);
  f.state.fail = () => { events.push("fail"); return false; };
  const executed = await f.runtime.run(f.cliPath, ["probe"], { cwd: f.project, env: { FIXTURE_RECEIPT: "received" } });
  assert.equal(executed.code, 0, executed.stderr);
  assert.equal(executed.stdout.trim(), "real dispatch");
  assert.equal(fs.readFileSync(marker, "utf8"), "received");
  assert.deepEqual(events, ["afterCommand", "fail", "afterCommand", "fail"]);
});
