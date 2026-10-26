"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isolatedEnvironment, mergeHostConfig, denyLinks } = require("./packaged-runtime.cjs");
const { startHost, wireProvider, portClosed } = require("./opencode-v1/host.cjs");

function hostFixture(context, script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-host-lifecycle-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "serve"), script);
  fs.writeFileSync(path.join(root, "opencode.json"), "{}");
  return { host: process.execPath, config: path.join(root, "opencode.json"),
    env: isolatedEnvironment(root), directories: { outside: root } };
}

async function promptly(operation) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("host lifecycle exceeded 1500ms")), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

test("startHost rejects a real immediate exit and reaches outer failure evidence and cleanup", async (context) => {
  const fixture = hostFixture(context, "process.exit(17);\n");
  const provider = await wireProvider();
  const evidence = { host: {}, cleanup: {} };
  const started = performance.now();
  let failure;
  try { await promptly(startHost(fixture, provider, evidence)); }
  catch (error) { failure = error; evidence.failure = error.message; }
  finally {
    await provider.close();
    evidence.cleanup.provider_port_closed = await portClosed(provider.url);
    fs.writeFileSync(path.join(fixture.directories.outside, "failure.json"), JSON.stringify(evidence));
  }
  assert.match(failure?.message || "", /host exited before ready: 17\/null/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.directories.outside, "failure.json")))
    .cleanup.provider_port_closed, true);
  context.diagnostic(`immediate exit rejected and outer cleanup completed in ${Math.round(performance.now() - started)}ms`);
});

test("startHost closes a real ready host after disposal already exited the child", async (context) => {
  const fixture = hostFixture(context, `
    const http = require('node:http');
    const port = Number(process.argv.find(arg => arg.startsWith('--port=')).split('=')[1]);
    const server = http.createServer((request, response) => {
      response.end('{}');
      server.close(() => process.exit(0));
    });
    server.listen(port, '127.0.0.1', () => {
      console.log('opencode server listening on http://127.0.0.1:' + port);
    });
  `);
  const evidence = { host: {}, cleanup: {} };
  const host = await startHost(fixture, { url: "http://127.0.0.1:1/v1" }, evidence);
  context.after(() => { try { process.kill(evidence.host.pid, "SIGKILL"); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  } });
  await promptly(host.close());
  await promptly(host.close());
  assert.equal(await portClosed(evidence.host.url), true);
  assert.ok(evidence.host.exit.code === 0 || evidence.host.exit.signal === "SIGTERM");
});

test("startHost rejects a real spawn error without an unhandled rejection", async (context) => {
  const fixture = hostFixture(context, "");
  fixture.host = path.join(fixture.directories.outside, "missing-host");
  await assert.rejects(promptly(startHost(fixture, { url: "http://127.0.0.1:1/v1" },
    { host: {}, cleanup: {} })), { code: "ENOENT" });
});

test("packaged harness isolates every persistent root without inheriting credentials", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-harness-env-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
    "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA", "MEMOCAP_DB", "npm_config_cache", "npm_config_prefix"]) {
    assert.ok(env[key].startsWith(root + path.sep), key);
  }
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.MEMOCAP_TOKEN, undefined);
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS, undefined);
  assert.ok(!env.PATH.split(path.delimiter).some((directory) => directory.startsWith(os.homedir() + path.sep)),
    "host tool discovery must not inspect personal global CLI prefixes");
});

test("host settings merge preserves the actual managed registration and user options", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-harness-merge-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "opencode.json");
  const installed = { plugin: [["@lyy-gh/memocap@0.3.0", { skillDirectory: root, automatic: false }]],
    skills: { paths: [root] }, theme: "operator-choice", provider: { retained: { name: "existing" } } };
  fs.writeFileSync(filename, `// operator configuration comment\n${JSON.stringify(installed)}`);
  mergeHostConfig(filename, { model: "wire/wire-model", provider: { wire: { name: "wire" } } });
  const configured = require("jsonc-parser").parse(fs.readFileSync(filename, "utf8"));
  assert.ok(fs.readFileSync(filename, "utf8").includes("// operator configuration comment"));
  assert.deepEqual(configured.plugin, installed.plugin);
  assert.deepEqual(configured.skills, installed.skills);
  assert.equal(configured.theme, "operator-choice");
  assert.deepEqual(configured.provider, { ...installed.provider, wire: { name: "wire" } });
});

test("no-link capability fixture rejects actual symbolic and hard link creation", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap no links "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  const log = denyLinks(root, env);
  const filename = path.join(root, "source");
  fs.writeFileSync(filename, "ordinary file");
  const result = require("node:child_process").spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    (async () => {
      for (const name of ['symlinkSync', 'linkSync']) {
        try { fs[name](process.argv[1], process.argv[2] + name); process.exit(7); }
        catch (error) { if (error.code !== 'EPERM') throw error; }
      }
      for (const name of ['symlink', 'link']) {
        try { await fs.promises[name](process.argv[1], process.argv[2] + name); process.exit(8); }
        catch (error) { if (error.code !== 'EPERM') throw error; }
      }
    })().catch(error => { console.error(error); process.exitCode = 9; });
  `, filename, path.join(root, "forbidden")], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 4);
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith("forbidden")), false);
});
