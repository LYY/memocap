"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function sandbox(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inventory stdio "));
  const previous = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = root;
  context.after(() => {
    for (const [key, setting] of Object.entries(previous)) {
      if (setting === undefined) delete process.env[key]; else process.env[key] = setting;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function inventoryScript(rows) {
  return `process.stdout.write(${JSON.stringify(JSON.stringify(rows))}); process.exit(0);`;
}

test("file stdout receives every row from a force-exiting large JSON producer", async (context) => {
  const root = sandbox(context);
  const { runProcess } = await import("../scripts/setup/process.mjs");
  const rows = Array.from({ length: 5000 }, (_, index) => ({ name: `skill-${index}`, path: `/skills/${index}`, agents: ["OpenCode"] }));
  const script = path.join(root, "producer.cjs");
  fs.writeFileSync(script, inventoryScript(rows));

  const execution = await runProcess(process.execPath, [script], { stdoutFile: true });

  assert.equal(execution.code, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout), rows);
  assert.deepEqual(fs.readdirSync(root), ["producer.cjs"]);
});

for (const stdout of ["[]", '[{"name":"memocap","path":"/with spaces","agents":["OpenCode"]}]', "invalid JSON"]) {
  test(`file stdout preserves ${stdout === "[]" ? "empty" : stdout.startsWith("[") ? "small" : "invalid"} output verbatim`, async (context) => {
    const root = sandbox(context);
    const { runProcess } = await import("../scripts/setup/process.mjs");

    const execution = await runProcess(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(stdout)}); process.exit(0)`], { stdoutFile: true });

    assert.equal(execution.code, 0);
    assert.equal(execution.stdout, stdout);
    assert.deepEqual(fs.readdirSync(root), []);
  });
}

test("capture is a private ordinary file and closes its descriptor", async (context) => {
  const root = sandbox(context);
  const { runProcess } = await import("../scripts/setup/process.mjs");
  const script = `const fs=require('node:fs'); const path=require('node:path'); const captures=fs.readdirSync(process.env.TMPDIR); const directory=path.join(process.env.TMPDIR,captures[0]); const filename=path.join(directory,fs.readdirSync(directory)[0]); console.log(JSON.stringify({regular:fs.fstatSync(1).isFile(),mode:fs.statSync(filename).mode & 511,directoryMode:fs.statSync(directory).mode & 511}));`;

  const execution = await runProcess(process.execPath, ["-e", script], { stdoutFile: true });

  assert.equal(execution.code, 0, execution.stderr);
  const metadata = JSON.parse(execution.stdout);
  assert.equal(metadata.regular, true);
  if (process.platform !== "win32") assert.deepEqual(metadata, { regular: true, mode: 0o600, directoryMode: 0o700 });
  assert.deepEqual(fs.readdirSync(root), []);
});

test("nonzero exit preserves stdout and stderr and cleans capture", async (context) => {
  const root = sandbox(context);
  const { runProcess } = await import("../scripts/setup/process.mjs");

  const execution = await runProcess(process.execPath, ["-e", 'console.log("[]"); console.error("denied"); process.exitCode=17'], { stdoutFile: true });

  assert.equal(execution.code, 17);
  assert.equal(execution.stdout, "[]\n");
  assert.equal(execution.stderr, "denied\n");
  assert.deepEqual(fs.readdirSync(root), []);
});

test("spawn failure cleans capture", async (context) => {
  const root = sandbox(context);
  const { runProcess } = await import("../scripts/setup/process.mjs");

  const execution = await runProcess(path.join(root, "missing-program"), [], { stdoutFile: true });

  assert.equal(execution.code, 127);
  assert.ok(execution.stderr.length > 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("timeout kills a termination-resistant producer and removes capture", async (context) => {
  const root = sandbox(context);
  const { runProcess } = await import("../scripts/setup/process.mjs");

  const execution = await runProcess(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); console.log(process.pid); setInterval(()=>{},1000)'], { stdoutFile: true, timeout: 1000 });

  assert.equal(execution.code, 1);
  const pid = Number(execution.stdout.trim());
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(fs.readdirSync(root), []);
});

for (const bytes of [4_000_000, 4_000_001]) {
  test(`file stdout enforces the ${bytes}-byte boundary after immediate exit`, async (context) => {
    const root = sandbox(context);
    const { runProcess } = await import("../scripts/setup/process.mjs");

    const execution = await runProcess(process.execPath, ["-e", `require('node:fs').writeSync(1,Buffer.alloc(${bytes},120)); process.exit(0)`], { stdoutFile: true });

    assert.equal(execution.code, bytes > 4_000_000 ? 1 : 0);
    assert.ok(Buffer.byteLength(execution.stdout) <= 4_000_000);
    if (bytes === 4_000_000) assert.equal(execution.stdout.length, bytes);
    assert.deepEqual(fs.readdirSync(root), []);
  });
}

test("live oversized stdout is killed before timeout and capture is removed", async (context) => {
  const root = sandbox(context);
  const { runProcess } = await import("../scripts/setup/process.mjs");
  const started = Date.now();

  const execution = await runProcess(process.execPath, ["-e", 'require("node:fs").writeSync(1,Buffer.alloc(4_000_001)); setInterval(()=>{},1000)'], { stdoutFile: true, timeout: 10_000 });

  assert.equal(execution.code, 1);
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("oversized stderr still terminates file capture", async (context) => {
  const root = sandbox(context);
  const { runProcess } = await import("../scripts/setup/process.mjs");

  const execution = await runProcess(process.execPath, ["-e", 'console.log("[]"); process.stderr.write("x".repeat(4_100_000)); setInterval(()=>{},1000)'], { stdoutFile: true, timeout: 10_000 });

  assert.equal(execution.code, 1);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("local skill discovery reads a large inventory without starting a process", async (context) => {
  const root = sandbox(context);
  const { inventorySkills } = await import("../scripts/setup/skill-discovery.mjs");
  const skills = path.join(root, "skills");
  for (let index = 0; index < 1500; index++) {
    const directory = path.join(skills, `other-${index}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: other-${index}\n---\n`);
  }
  fs.mkdirSync(path.join(skills, "memocap"));
  fs.writeFileSync(path.join(skills, "memocap/SKILL.md"), "---\nname: memocap\n---\n");
  const scope = { directory: root, home: root, config_directories: [root], layers: [], config: path.join(root, "opencode.json") };
  const inventory = inventorySkills(scope, { env: { OPENCODE_DISABLE_EXTERNAL_SKILLS: "1" }, run: () => assert.fail("discovery cannot start a process") });
  assert.equal(inventory.discovered.length, 1);
  assert.equal(inventory.discovered[0].discovery_path, path.join(skills, "memocap"));
});

for (const skills of [null, [], "invalid", { paths: null }, { paths: [null] }, { paths: [123] }]) test(`local config boundary rejects malformed skills ${JSON.stringify(skills)}`, async () => {
  const { parseConfig } = await import("../scripts/setup/config.mjs");
  assert.throws(() => parseConfig("fixture.json", JSON.stringify({ skills })), { code: "invalid_skill_config" });
});
