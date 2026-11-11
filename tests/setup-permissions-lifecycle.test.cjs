"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { tools, permissionFixture, readConfig, readRecord, snapshot, installed05 } = require("./setup-permission-fixtures.cjs");

for (const permission of [undefined, "allow", { memocap_recall: "allow", memocap_read: "allow", bash: "ask" }, { memocap_recall: { "*": "allow", other: "deny" } }]) {
  test(`uninstall restores prior permission structure ${JSON.stringify(permission)}`, async (context) => {
    const setup = permissionFixture(context, permission === undefined ? {} : { permission });
    const installed = await setup.setup(["install", "--yes"]);
    assert.equal(installed.exit_code, 0, JSON.stringify(installed.error));
    for (const tool of tools) assert.equal(readConfig(setup).permission[tool].library, "allow");
    if (permission === "allow") assert.equal(readConfig(setup).permission["*"], "allow");
    const report = await setup.setup(["uninstall", "--yes"]);
    assert.equal(report.exit_code, 0, JSON.stringify(report.error));
    assert.deepEqual(readConfig(setup).permission, permission);
    assert.deepEqual(JSON.parse(fs.readFileSync(report.manifest_path)).installs, {});
  });
}

test("an existing explicit allow remains user owned through update and uninstall", async (context) => {
  const permission = { memocap_recall: { library: "allow" }, memocap_read: { library: "allow" }, memocap_remember: "ask" };
  const setup = permissionFixture(context, { permission });
  const installed = await setup.setup(["install", "--yes"]);
  assert.equal(installed.exit_code, 0, JSON.stringify(installed.error));
  assert.deepEqual(readRecord(installed).permissions.leaves, []);
  assert.equal((await setup.setup(["update", "--to", "0.5.0", "--yes"])).exit_code, 0);
  assert.equal((await setup.setup(["uninstall", "--yes"])).exit_code, 0);
  assert.deepEqual(readConfig(setup).permission, permission);
});

test("same-version update retains the scalar permission prior state for later uninstall", async (context) => {
  const setup = permissionFixture(context, { permission: "allow" });
  const installed = await setup.setup(["install", "--yes"]);
  const ownership = readRecord(installed).permissions;
  const updated = await setup.setup(["update", "--to", "0.5.0", "--yes"]);
  assert.equal(updated.exit_code, 0, JSON.stringify(updated.error));
  assert.deepEqual(readRecord(updated).permissions, ownership);
  assert.equal((await setup.setup(["uninstall", "--yes"])).exit_code, 0);
  assert.equal(readConfig(setup).permission, "allow");
});

test("update records only the latest prior state when the user replaces a grant container", async (context) => {
  const setup = permissionFixture(context);
  assert.equal((await setup.setup(["install", "--yes"])).exit_code, 0);
  const current = readConfig(setup);
  current.permission = "allow";
  fs.writeFileSync(setup.config, JSON.stringify(current));
  const report = await setup.setup(["update", "--to", "0.5.0", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.deepEqual(readRecord(report).permissions.containers.filter(({ path }) => path.length === 1), [{ path: ["permission"], previous: "allow" }]);
  assert.equal((await setup.setup(["uninstall", "--yes"])).exit_code, 0);
  assert.equal(readConfig(setup).permission, "allow");
});

test("uninstall dry-run declares only owned leaf removals and leaves config and manifest intact", async (context) => {
  const setup = permissionFixture(context, { permission: { memocap_recall: { library: "allow" } } });
  assert.equal((await setup.setup(["install", "--yes"])).exit_code, 0);
  const before = snapshot(setup.root);
  const report = await setup.setup(["uninstall", "--dry-run"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.deepEqual(report.plan.scopes[0].permissions.edits.filter(({ path }) => path.at(-1) === "library"), [{ path: ["permission", "memocap_read", "library"], remove: true }]);
  assert.deepEqual(snapshot(setup.root), before);
});

test("uninstall of an old format-2 owner without grant state leaves user permissions intact", async (context) => {
  const { setup } = await installed05(context);
  const current = readConfig(setup);
  current.permission = { memocap_recall: { library: "allow" }, memocap_read: { library: "allow" } };
  fs.writeFileSync(setup.config, JSON.stringify(current));
  const report = await setup.setup(["uninstall", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.deepEqual(readConfig(setup).permission, current.permission);
});

for (const action of ["deny", "ask"]) {
  test(`user leaf change to ${action} survives uninstall while the other owned leaf is removed`, async (context) => {
    const setup = permissionFixture(context);
    assert.equal((await setup.setup(["install", "--yes"])).exit_code, 0);
    const current = readConfig(setup);
    current.permission.memocap_read.library = action;
    current.permission.memocap_recall.extra = "ask";
    current.permission.edit = "deny";
    fs.writeFileSync(setup.config, JSON.stringify(current));
    const report = await setup.setup(["uninstall", "--yes"]);
    assert.equal(report.exit_code, 0, JSON.stringify(report.error));
    assert.deepEqual(readConfig(setup).permission, { memocap_read: { library: action }, memocap_recall: { extra: "ask" }, edit: "deny" });
  });
}

test("JSONC comments within a changed grant container and unrelated permissions survive removal", async (context) => {
  const setup = permissionFixture(context, '{/* root */"permission":{/* user rules */"bash":"ask"},"model":"keep"}');
  assert.equal((await setup.setup(["install", "--yes"])).exit_code, 0);
  const text = fs.readFileSync(setup.config, "utf8").replace('"library": "allow"', '"library": /* user note */ "allow"');
  fs.writeFileSync(setup.config, text);
  const report = await setup.setup(["uninstall", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  const observed = fs.readFileSync(setup.config, "utf8");
  for (const comment of ["/* root */", "/* user rules */", "/* user note */"]) assert.equal(observed.includes(comment), true);
  assert.equal(readConfig(setup).permission.bash, "ask");
  assert.equal(readConfig(setup).model, "keep");
  for (const tool of tools) assert.equal(readConfig(setup).permission[tool]?.library, undefined);
});

test("user modified grant blocks update without altering config or installation state", async (context) => {
  const setup = permissionFixture(context);
  assert.equal((await setup.setup(["install", "--yes"])).exit_code, 0);
  const current = readConfig(setup);
  current.permission.memocap_recall.library = "deny";
  fs.writeFileSync(setup.config, JSON.stringify(current));
  const before = snapshot(setup.root);
  const report = await setup.setup(["update", "--to", "0.5.0", "--yes"]);
  assert.equal(report.error?.code, "library_permission_conflict");
  assert.deepEqual(snapshot(setup.root), before);
});

test("config outcome unknown persists intent and resumes by readback without a second config commit", async (context) => {
  const setup = permissionFixture(context);
  const rename = fs.renameSync;
  let commits = 0;
  context.mock.method(fs, "renameSync", (source, destination) => {
    const committed = rename(source, destination);
    if (destination === setup.config) {
      commits++;
      if (commits === 1) throw Object.assign(new Error("lost acknowledgement"), { code: "config_outcome_unknown" });
    }
    return committed;
  });
  const partial = await setup.setup(["install", "--yes"]);
  assert.equal(partial.error?.code, "config_outcome_unknown");
  assert.equal(readRecord(partial).intent.permissions.owned.leaves.length, 2);
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.equal(commits, 1);
  assert.equal(readRecord(report).permissions.leaves.length, 2);
  assert.equal(readRecord(report).intent, undefined);
});

test("an uncertain config commit followed by user edits cannot replay stale permission edits", async (context) => {
  const setup = permissionFixture(context);
  const rename = fs.renameSync;
  let commits = 0;
  context.mock.method(fs, "renameSync", (source, destination) => {
    const committed = rename(source, destination);
    if (destination === setup.config) { commits++; throw Object.assign(new Error("lost acknowledgement"), { code: "config_outcome_unknown" }); }
    return committed;
  });
  assert.equal((await setup.setup(["install", "--yes"])).error?.code, "config_outcome_unknown");
  const current = readConfig(setup);
  current.permission.memocap_read.additional = "allow";
  fs.writeFileSync(setup.config, JSON.stringify(current));
  const before = snapshot(setup.root);
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.error?.code, "concurrent_change");
  assert.equal(commits, 1);
  assert.deepEqual(snapshot(setup.root), before);
});
