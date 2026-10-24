"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { sandbox, fixture, user } = require("./plugin-fixture.cjs");

const root = path.resolve(__dirname, "..");
const packageVersion = require("../package.json").version;
const output = path.join(root, ".omo/evidence/memocap-observable-opencode-v1/plugin-fixes.json");
const report = { format_version: 1, status: "running", started_at: new Date().toISOString(),
  scope: "plugin integration; native caller and linked observations, not model adoption",
  changed_files: ["plugin/activity.js", "plugin/bridge.js", "plugin/commands.js", "plugin/operations.js",
    "plugin/protocol.js", "plugin/recall.js", "plugin/tools.js", "tests/plugin-fixture.cjs",
    "tests/plugin-commands.test.cjs", "tests/plugin-recall.test.cjs", "tests/plugin-protocol.test.cjs",
    "tests/plugin-bridge.test.cjs", "tests/plugin-native-driver.cjs"],
  runtime: { node: process.version, platform: process.platform }, commands: [], checks: [],
  host_contract_note: "Compiled Bun/OpenCode resolves node (node.exe on Windows) from PATH and verifies actual Node >=22.20 once per bridge. No new runtime configuration. Package-relative absolute launcher and per-command exact package handshake remain required.",
  limitations: ["Actual OpenCode host/provider capture belongs to the host worker; compiled Bun regression proves child runtime selection, not LLM adoption.",
    "Native driver is local. Authenticated HTTP caller retention is verified by backend owner, not this plugin driver."] };
if (fs.existsSync(output)) {
  const previous = JSON.parse(fs.readFileSync(output, "utf8"));
  report.previous_attempts = [...(previous.previous_attempts ?? []), { status: previous.status,
    checks: previous.checks?.length, error: previous.error, cleanup: previous.cleanup }];
}

const save = () => fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  report.checks.push({ name, actual });
  save();
}

async function main() {
  save();
  const originalEnv = { ...process.env };
  let fixturePackage;
  let hooks;
  try {
    fixturePackage = await sandbox();
    const temporary = fs.realpathSync(fixturePackage.root);
    const native = path.join(temporary, process.platform === "win32" ? "native.exe" : "native");
    const sourceNative = path.join(root, "target/debug", process.platform === "win32" ? "memocap.exe" : "memocap");
    fs.copyFileSync(sourceNative, native);
    fs.chmodSync(native, 0o755);
    for (const filename of ["cli.cjs", "cache-lock.cjs"]) {
      fs.copyFileSync(path.join(root, "bin", filename), path.join(temporary, "bin", filename));
    }
    const home = path.join(temporary, "isolated-home");
    fs.mkdirSync(home);
    const db = path.join(home, "core.db");
    const actualDirectory = fs.realpathSync(fixturePackage.B);
    const env = { PATH: originalEnv.PATH, SystemRoot: originalEnv.SystemRoot, HOME: home, MEMOCAP_HOME: home,
      MEMOCAP_DATA_DIR: home, MEMOCAP_DB: db, MEMOCAP_BINARY: native, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, entry] of Object.entries(env)) if (entry !== undefined) process.env[key] = entry;
    report.isolation = { root: temporary, database: db, home, native, source_native: sourceNative,
      sha256: createHash("sha256").update(fs.readFileSync(native)).digest("hex"), inherited_environment: false };

    const nativeRun = (argv, expectedExit = 0) => {
      const executed = spawnSync(native, argv, { cwd: actualDirectory, env: process.env,
        encoding: "utf8", shell: false, timeout: 5000, maxBuffer: 1024 * 1024 });
      report.commands.push({ executable: native, argv, cwd: actualDirectory, pid: executed.pid,
        exit_code: executed.status, stdout: executed.stdout, stderr: executed.stderr, signal: executed.signal });
      save();
      assert.equal(executed.error, undefined);
      assert.equal(executed.status, expectedExit, executed.stderr);
      return argv.includes("--json") ? JSON.parse(executed.stdout) : executed.stdout;
    };

    check("native and package version agree", nativeRun(["--version"]).trim(), `memocap ${packageVersion}`);
    const host = fixture();
    host.input.client.session.get = async () => ({ data: { directory: actualDirectory } });
    hooks = await fixturePackage.module.default.server(host.input);
    await hooks.config({});
    const permissions = [];
    const context = { sessionID: "plugin-native-session", messageID: "plugin-native-write-message",
      directory: fixturePackage.A, worktree: fixturePackage.A, abort: new AbortController().signal,
      metadata() {}, ask: async (permission) => { permissions.push(permission); throw new Error("denied"); } };
    for (const [name, args] of [["memocap_scope", { paths: ["."] }], ["memocap_remember", { content: "denied" }]]) {
      check(`${name} denied`, JSON.parse((await hooks.tool[name].execute(args, context)).output).status, "denied");
      check(`${name} created no core or auxiliary sidecar`, fs.readdirSync(home), []);
    }
    context.ask = async (permission) => { permissions.push(permission); };
    const scoped = JSON.parse((await hooks.tool.memocap_scope.execute({ paths: ["."] }, context)).output);
    check("relative scope used session directory despite different ToolContext", scoped.targets[0].canonical_path, actualDirectory);
    check("scope permission targets equal executed targets", permissions.at(-1).patterns, [actualDirectory]);

    nativeRun(["remember", "universal shadow fixture", "--universal", "--topic", "shadow-topic", "--force", "--json"]);
    nativeRun(["remember", "repository shadow winner", "--topic", "shadow-topic", "--force", "--json"]);
    const marker = path.join(temporary, "must-not-exist");
    const content = `pluginproofanchor literal --caller-json "quote" $(touch '${marker}')\nnext line & %PATH%`;
    const saved = JSON.parse((await hooks.tool.memocap_remember.execute({ content, repository: ".", universal: true,
      topic: "plugin-proof", tags: ["literal", "proof"], type: "decision" }, context)).output);
    report.write = saved;
    check("real write inserted", saved.status, "inserted");
    check("independent inventory readback succeeded with shadowed rows", saved.readback.status, "ok");
    check("receipt retains actual caller", saved.caller,
      { actor: "plugin", session_id: context.sessionID, message_id: context.messageID });
    check("remember approved the same actual directory", permissions.at(-1).patterns, [actualDirectory]);
    const inventory = nativeRun(["list", "--placement", "universal", "--limit", "20", "--repo", actualDirectory, "--json"]);
    check("native inventory includes a shadowed memory", inventory.results.some((entry) => entry.visibility === "shadowed"), true);
    check("readback preserves literal content", inventory.results.find((entry) => entry.memory.id === saved.returned_ids[0]).memory.content, content);
    check("shell expression never executed", fs.existsSync(marker), false);

    const writes = nativeRun(["activity", "list", "--writes", "--session", context.sessionID, "--limit", "100", "--json"]);
    report.native_write_events = writes.events;
    check("only one actual plugin write event", writes.events.length, 1);
    const committed = writes.events[0];
    check("history links to actual committed write", committed.operation_id, saved.operation_id);
    check("committed native context has caller and native origin", committed.context,
      { repository_ids: committed.context.repository_ids, actor: "plugin", session_id: context.sessionID,
        message_id: context.messageID, origin: "cli", backend: "local" });

    const message = user(context.sessionID, "plugin-native-user-message", "pluginproofanchor");
    await hooks["chat.message"]({ sessionID: context.sessionID }, { message: message.info, parts: message.parts });
    await hooks["experimental.chat.messages.transform"]({}, { messages: [message] });
    const first = { ...message.parts.at(-1).metadata.memocap };
    check("actual native recall prepared saved ID", first.injected_ids.includes(saved.returned_ids[0]), true);
    await hooks["experimental.chat.messages.transform"]({}, { messages: [message] });
    const cached = { ...message.parts.at(-1).metadata.memocap };
    check("second transform uses original native recall", cached.operation_id, first.operation_id);
    check("second transform is cached", cached.cache_hit, true);
    check("observations have distinct fresh UUIDs", new Set([first.operation_id, first.activity_operation_id, cached.activity_operation_id]).size, 3);
    report.recall = { first, cached };
    for (const observation of [first, cached]) {
      const shown = nativeRun(["activity", "show", observation.activity_operation_id, "--json"]);
      check("both observation phases persist original native parent", shown.events.map((event) => event.related_operation_id),
        [first.operation_id, first.operation_id]);
      check("observation phases are recall and injection_prepared", shown.events.map((event) => event.detail.phase).sort(),
        ["injection_prepared", "recall"]);
    }
    const history = nativeRun(["activity", "list", "--session", context.sessionID, "--limit", "100", "--json"]);
    report.observations = history.events.filter((event) => [first.activity_operation_id, cached.activity_operation_id].includes(event.operation_id));
    check("list retains all four linked observation phases", report.observations.length, 4);
    check("list retains parent links", report.observations.every((event) => event.related_operation_id === first.operation_id), true);
    const nativeRecall = history.events.filter((event) => event.operation_id === first.operation_id);
    check("cache hit does not repeat native recall", nativeRecall.length, 1);
    check("native recall retains actual message caller", nativeRecall[0].context.message_id, message.info.id);

    const commandOutput = { parts: [{ type: "text", messageID: "plugin-native-command-message", text: "memory recent" }] };
    const originalParts = commandOutput.parts;
    await hooks["command.execute.before"]({ command: "memory", sessionID: context.sessionID, arguments: "recent" }, commandOutput);
    check("command writes into host-owned parts", originalParts === commandOutput.parts, true);
    check("recent renders real session write", JSON.parse(originalParts[0].text).events[0].operation_id, saved.operation_id);
    const beforeIDs = inventory.returned_ids;
    const invalid = nativeRun(["remember", "must not write", "--caller-json", JSON.stringify({ actor: "plugin", session_id: "\n" }), "--json"], 2);
    check("native caller boundary rejects control input", invalid.status, "failed");
    const afterInventory = nativeRun(["list", "--placement", "universal", "--limit", "20", "--repo", actualDirectory, "--json"]);
    check("invalid caller did not change saved inventory", afterInventory.returned_ids, beforeIDs);
    await hooks["experimental.session.compacting"]({ sessionID: context.sessionID }, { context: [] });
    await hooks["command.execute.before"]({ command: "memory", sessionID: context.sessionID, arguments: "why" }, commandOutput);
    check("compaction clears stale recall state", JSON.parse(commandOutput.parts[0].text).status, "not_run");
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = { message: error.message, stack: error.stack };
    process.exitCode = 1;
  } finally {
    await hooks?.dispose();
    fixturePackage?.cleanup();
    report.cleanup = { disposed: Boolean(hooks), sandbox_removed: fixturePackage ? !fs.existsSync(fixturePackage.root) : true,
      child_processes: "awaited bridge requests; sync native commands bounded by 5s timeout", personal_writes: false };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    report.finished_at = new Date().toISOString();
    save();
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, artifact: output, cleanup: report.cleanup }));
  }
}

main().catch((error) => { report.status = "blocked"; report.error = { message: error.message }; save(); process.exitCode = 1; });
