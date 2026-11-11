"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { tools, grantPaths, permissionFixture, readConfig, readRecord, snapshot, installed05 } = require("./setup-permission-fixtures.cjs");

test("dry-run declares exact library edits and leaves the isolated filesystem untouched", async (context) => {
  const setup = permissionFixture(context);
  const before = snapshot(setup.root);
  const report = await setup.setup(["install", "--dry-run"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.deepEqual(report.plan.scopes[0].permissions.edits.filter(({ path }) => path.at(-1) === "library"), grantPaths.map((path) => ({ path, value: "allow" })));
  assert.deepEqual(report.plan.scopes[0].permissions.owned.leaves.map(({ path }) => path), grantPaths);
  assert.deepEqual(report.plan.scopes[0].permissions.effects, ["read_library_memories", "read_full_memory_by_id"]);
  assert.equal(report.plan.scopes[0].permissions.runtime_verification, "not_run");
  assert.deepEqual(snapshot(setup.root), before);
  assert.equal(setup.calls.some(({ args }) => ["install", "add", "remove", "uninstall"].includes(args[0])), false);
});

test("new installation commits grants with plugin references once and records leaf ownership", async (context) => {
  const setup = permissionFixture(context, '{\r\n// user config\r\n"model":"keep",\r\n"permission":{"bash":"ask","memocap_remember":"deny"}\r\n}\r\n');
  const rename = fs.renameSync;
  let commits = 0;
  context.mock.method(fs, "renameSync", (source, destination) => { if (destination === setup.config) commits++; return rename(source, destination); });
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.equal(commits, 1);
  assert.deepEqual(readConfig(setup).permission, { bash: "ask", memocap_remember: "deny", memocap_recall: { library: "allow" }, memocap_read: { library: "allow" } });
  assert.deepEqual(readRecord(report).permissions.leaves, grantPaths.map((path) => ({ path, value: "allow" })));
  assert.equal(JSON.parse(fs.readFileSync(report.manifest_path)).format_version, 2);
  assert.equal(report.scopes[0].permissions.grants.every(({ status }) => status === "explicit_allow"), true);
  const text = fs.readFileSync(setup.config, "utf8");
  assert.equal(text.includes("// user config\r\n"), true);
  assert.equal(/(?<!\r)\n/.test(text), false);
  assert.equal(report.runtime.status, "not_run");
});

test("update adds grants to the installed 0.5 format-2 shape without changing existing data", async (context) => {
  const { setup, installed } = await installed05(context);
  const record = readRecord(installed);
  const database = path.join(setup.home, ".memocap/memocap.db");
  const contents = fs.readFileSync(database);
  const report = await setup.setup(["update", "--to", "0.5.0", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.deepEqual(tools.map((tool) => readConfig(setup).permission[tool].library), ["allow", "allow"]);
  assert.deepEqual(readRecord(report).permissions.leaves.map(({ path }) => path), grantPaths);
  assert.deepEqual(readRecord(report).plugin.entry, record.plugin.entry);
  assert.deepEqual(fs.readFileSync(database), contents);
  const repeated = await setup.setup(["update", "--to", "0.5.0", "--yes"]);
  assert.equal(repeated.status, "unchanged");
  assert.deepEqual(readRecord(repeated).permissions, readRecord(report).permissions);
});

test("update dry-run of a managed 0.5 installation only declares the missing grants", async (context) => {
  const { setup } = await installed05(context);
  const before = snapshot(setup.root);
  const report = await setup.setup(["update", "--to", "0.5.0", "--dry-run"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.deepEqual(report.plan.scopes[0].permissions.edits.filter(({ path }) => path.at(-1) === "library"), grantPaths.map((path) => ({ path, value: "allow" })));
  assert.deepEqual(snapshot(setup.root), before);
});

for (const action of ["deny", "ask"]) for (const permission of [action, { "*": action }, { memocap_recall: action }, { memocap_read: { library: action } }, { "memocap_*": { "lib*": action } }]) {
  test(`explicit permission limit ${JSON.stringify(permission)} survives install preflight`, async (context) => {
    const setup = permissionFixture(context, { permission });
    const before = snapshot(setup.root);
    const report = await setup.setup(["install", "--yes"]);
    assert.equal(report.error?.code, "library_permission_conflict");
    assert.equal(report.scopes[0].permissions.conflicts.some((conflict) => conflict.action === action), true);
    assert.deepEqual(snapshot(setup.root), before);
    assert.equal(setup.calls.some(({ args }) => args[0] === "install"), false);
  });
}

test("higher project limits block inherited grants without creating a project installation", async (context) => {
  const setup = permissionFixture(context);
  assert.equal((await setup.setup(["install", "--yes"])).exit_code, 0);
  const config = path.join(setup.project, "opencode.jsonc");
  fs.writeFileSync(config, '{/* user */"permission":{"memocap_read":{"library":"deny"}}}');
  const before = snapshot(setup.root);
  const report = await setup.setup(["install", "--project", setup.project, "--yes"]);
  assert.equal(report.error?.code, "library_permission_conflict");
  assert.deepEqual(snapshot(setup.root), before);
});

test("project reuse reports the global grant owner without claiming or writing project grants", async (context) => {
  const setup = permissionFixture(context);
  const global = await setup.setup(["install", "--yes"]);
  const permissions = readRecord(global).permissions;
  const before = fs.readFileSync(setup.config, "utf8");
  const report = await setup.setup(["install", "--project", setup.project, "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.equal(report.scopes[0].owner_reused, true);
  assert.equal(report.plan.scopes[0].permissions.action, "reuse_owner");
  assert.equal(report.plan.scopes[0].permissions.config, setup.config);
  assert.equal(fs.existsSync(path.join(setup.project, "opencode.jsonc")), false);
  assert.equal(fs.readFileSync(setup.config, "utf8"), before);
  assert.deepEqual(readRecord(report).permissions, permissions);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(report.manifest_path)).installs).length, 1);
});

test("agent permission limits are reported without changing native writes or claiming runtime verification", async (context) => {
  const agent = { build: { permission: { memocap_recall: "deny", memocap_read: { library: "ask" }, memocap_remember: "deny" } } };
  const setup = permissionFixture(context, { agent, permission: { memocap_remember: "ask" } });
  const report = await setup.setup(["install", "--yes"]);
  assert.equal(report.exit_code, 0, JSON.stringify(report.error));
  assert.deepEqual(readConfig(setup).agent, agent);
  assert.equal(readConfig(setup).permission.memocap_remember, "ask");
  assert.deepEqual(report.scopes[0].permissions.agent_limits.map(({ agent, action }) => ({ agent, action })), [{ agent: "build", action: "deny" }, { agent: "build", action: "ask" }]);
  assert.equal(report.scopes[0].permissions.runtime_verification, "not_run");
});

test("project reuse of a managed 0.5 owner with missing grants requires the global owner update", async (context) => {
  const { setup } = await installed05(context);
  const before = snapshot(setup.root);
  const report = await setup.setup(["install", "--project", setup.project, "--yes"]);
  assert.equal(report.error?.code, "owner_permissions_missing");
  assert.deepEqual(report.plan.scopes[0].permissions.edits, []);
  assert.deepEqual(report.plan.scopes[0].permissions.owner_required_edits.filter(({ path }) => path.at(-1) === "library"), grantPaths.map((path) => ({ path, value: "allow" })));
  assert.deepEqual(snapshot(setup.root), before);
});

for (const rules of [{ library: "allow", "*": "deny" }, { library: "deny", "*": "allow" }]) {
  test(`matching later rules or exact denial prevent grants ${JSON.stringify(rules)}`, async (context) => {
    const setup = permissionFixture(context, { permission: { memocap_read: rules } });
    const before = snapshot(setup.root);
    const report = await setup.setup(["install", "--yes"]);
    assert.equal(report.error?.code, "library_permission_conflict");
    assert.equal(report.plan.scopes[0].permissions.grants.find(({ path }) => path[1] === "memocap_read").action, "blocked");
    assert.deepEqual(snapshot(setup.root), before);
  });
}
