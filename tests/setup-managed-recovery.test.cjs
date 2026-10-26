"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { fixture } = require("./setup-fixtures.cjs");

test("an update committed before manifest failure retains the new ownership after resume", async (context) => {
  const f = fixture(context);
  assert.equal((await f.setup(["install", "--yes"])).exit_code, 0);
  fs.writeFileSync(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "@lyy-gh/memocap", version: "0.2.0" }));
  fs.appendFileSync(path.join(f.packageRoot, "skills/memocap/SKILL.md"), "new fixture release\n");
  const rename = fs.renameSync;
  let committed = false;
  let failed = false;
  context.mock.method(fs, "renameSync", (source, destination) => {
    if (committed && !failed && destination === path.join(f.env.XDG_STATE_HOME, "memocap/setup.json")) { failed = true; throw Object.assign(new Error("manifest commit fault"), { code: "EACCES" }); }
    const outcome = rename(source, destination);
    if (destination === f.config) committed = true;
    return outcome;
  });
  const partial = await f.setup(["update", "--to", "0.2.0", "--yes"]);
  context.mock.restoreAll();
  assert.equal(partial.error.code, "manifest_write_failed");
  assert.equal((await f.setup(["update", "--to", "0.2.0", "--yes"])).exit_code, 0);
  const repeated = await f.setup(["update", "--to", "0.2.0", "--yes"]);
  assert.equal(repeated.error, null);
  assert.equal(repeated.status, "unchanged");
});

test("config CAS interruption preserves user bytes and resume retains unrelated changes", async (context) => {
  const f = fixture(context);
  fs.mkdirSync(path.dirname(f.config), { recursive: true });
  fs.writeFileSync(f.config, "{}\r\n");
  const rename = fs.renameSync;
  let failed = false;
  context.mock.method(fs, "renameSync", (source, destination) => {
    if (destination === f.config && !failed) { failed = true; throw Object.assign(new Error("config switch interrupted"), { code: "EACCES" }); }
    return rename(source, destination);
  });
  const partial = await f.setup(["install", "--yes"]);
  context.mock.restoreAll();
  assert.equal(partial.error.code, "EACCES");
  assert.equal(fs.readFileSync(f.config, "utf8"), "{}\r\n");
  f.calls.length = 0;
  const recovered = await f.setup(["install", "--yes"]);
  assert.equal(recovered.exit_code, 0, JSON.stringify(recovered.error));
  assert.equal(f.calls.some(({ args }) => args[0] === "install"), false);
  assert.equal(recovered.steps.find(({ component }) => component === "skill").status, "unchanged");
});

test("a user modification after a partial config switch cannot be silently adopted", async (context) => {
  const f = fixture(context);
  assert.equal((await f.setup(["install", "--yes"])).exit_code, 0);
  const config = JSON.parse(fs.readFileSync(f.config));
  config.plugin[0][1].skillDirectory = path.join(f.root, "unknown policy");
  fs.writeFileSync(f.config, JSON.stringify(config));
  const before = fs.readFileSync(f.config, "utf8");
  f.calls.length = 0;
  const report = await f.setup(["install", "--yes"]);
  assert.equal(report.error.code, "plugin_modified");
  assert.equal(fs.readFileSync(f.config, "utf8"), before);
  assert.equal(f.calls.some(({ args }) => args[0] === "install"), false);
});
