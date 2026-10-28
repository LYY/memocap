"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isolatedEnvironment, mergeHostConfig, denyLinks, linkEvents, assertManagedLinks, retainLinkEvents } = require("./packaged-runtime.cjs");
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

for (const phase of ["current-managed", "unknown"]) {
  for (const api of ["symlinkSync", "linkSync", "symlink", "link", "promises.symlink", "promises.link"]) {
    test(`caught ${api} rejection still fails ${phase} acceptance and survives cleanup`, (context) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-link-event-"));
      const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-link-artifact-"));
      context.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(artifactRoot, { recursive: true, force: true });
      });
      const env = isolatedEnvironment(root);
      env.MEMOCAP_LINK_PHASE = phase;
      const log = denyLinks(root, env);
      const source = path.join(root, "source");
      const destination = path.join(root, "forbidden");
      fs.writeFileSync(source, "ordinary bytes");
      const child = require("node:child_process").spawnSync(process.execPath, ["-e", `
        const fs = require('node:fs');
        (async () => {
          try {
            const api = process.argv[3];
            if (api.startsWith('promises.')) await fs.promises[api.split('.')[1]](process.argv[1], process.argv[2]);
            else if (api.endsWith('Sync')) fs[api](process.argv[1], process.argv[2]);
            else await new Promise((resolve, reject) => fs[api](process.argv[1], process.argv[2], error => error ? reject(error) : resolve()));
            process.exitCode = 7;
          } catch (error) { if (error.code !== 'EPERM') throw error; }
        })().catch(error => { console.error(error); process.exitCode = 8; });
      `, source, destination, api], { env, encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(fs.existsSync(destination), false);
      const original = linkEvents(log);
      assert.equal(original.events.length, 1);
      assert.equal(original.events[0].api, api);
      assert.equal(original.events[0].pid, child.pid);
      assert.equal(original.events[0].ppid, process.pid);
      assert.equal(original.events[0].phase, phase);
      assert.equal(original.events[0].source, "<sandbox>/source");
      assert.ok(original.events[0].stack.length > 1);
      assert.throws(() => assertManagedLinks(log), /unexpected link attempt/);
      const artifact = path.join(artifactRoot, "failure.json");
      retainLinkEvents(log, { status: "failed" }, artifact);
      fs.rmSync(root, { recursive: true });
      assert.deepEqual(JSON.parse(fs.readFileSync(artifact)).link_guard, original);
    });
  }
}

test("only attributed official bootstrap hardlinks are outside the managed zero-attempt contract", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-bootstrap-events-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "events.jsonl");
  const entry = "<sandbox>/tools/node_modules/opencode-ai/postinstall.mjs";
  const event = { api: "linkSync", pid: 123, ppid: 122, phase: "official-host-bootstrap", entry,
    entry_sha256: "5a7c990fe552e76b16422cdba3f4b0550590c7a487f7932c773362f74317c87b",
    source: "<sandbox>/tools/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe",
    destination: "<sandbox>/tools/node_modules/opencode-ai/bin/opencode.exe",
    stack: [`    at copyBinary (${entry}:151:8)`] };
  fs.writeFileSync(log, `${JSON.stringify(event)}\n`);
  assert.equal(assertManagedLinks(log).attempted_links, 0);
  assert.equal(assertManagedLinks(log).bootstrap_attempted_links, 1);
  assert.equal(linkEvents(log).events.length, 1);
  const changes = [{ phase: "current-managed" }, { phase: "unknown" }, { api: "symlinkSync" },
    { entry_sha256: "unknown" }, { stack: [] }, { destination: "<sandbox>/managed/skill" }];
  for (const [index, changed] of changes.entries()) {
    const negative = path.join(root, `negative-${index}.jsonl`);
    fs.writeFileSync(negative, `${JSON.stringify(event)}\n${JSON.stringify({ ...event, ...changed })}\n`);
    assert.throws(() => assertManagedLinks(negative), /unexpected link attempt/);
    assert.equal(linkEvents(negative).events.length, 2);
  }
  assert.equal(linkEvents(log).events.length, 1);
  const malformed = path.join(root, "malformed.jsonl");
  fs.writeFileSync(malformed, "incomplete unknown event\n");
  assert.throws(() => assertManagedLinks(malformed), /unexpected link attempt in unknown/);
  const artifact = path.join(root, "malformed.json");
  retainLinkEvents(malformed, { status: "failed" }, artifact);
  assert.equal(JSON.parse(fs.readFileSync(artifact)).link_guard.raw, "incomplete unknown event\n");
});

test("registry-verified official postinstall copies after denied hardlink with its actual caller attributed", async (context) => {
  const { spawnSync } = require("node:child_process");
  const crypto = require("node:crypto");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-official-link-control-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  const download = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, url);
    return Buffer.from(await response.arrayBuffer());
  };
  const metadata = JSON.parse(await download("https://registry.npmjs.org/opencode-ai/1.19.3"));
  assert.equal(metadata.scripts.postinstall, "node ./postinstall.mjs");
  const bytes = await download(metadata.dist.tarball);
  assert.equal(`sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`, metadata.dist.integrity);
  const archive = path.join(root, "official.tgz");
  fs.writeFileSync(archive, bytes);
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", root], { env, encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);
  const hostRoot = path.join(root, "tools/node_modules/opencode-ai");
  fs.mkdirSync(path.dirname(hostRoot), { recursive: true });
  fs.renameSync(path.join(root, "package"), hostRoot);
  const platform = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform];
  const base = `opencode-${platform}-${process.arch}`;
  const binaryName = process.platform === "win32" ? "opencode.exe" : "opencode";
  const standIn = process.platform === "win32" ? fs.readFileSync(process.execPath) : Buffer.from("#!/bin/sh\nexit 0\n");
  for (const name of [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]) {
    const directory = path.join(hostRoot, "node_modules", name);
    fs.mkdirSync(path.join(directory, "bin"), { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.19.3" }));
    fs.writeFileSync(path.join(directory, "bin", binaryName), standIn, { mode: 0o755 });
  }
  const script = path.join(hostRoot, "postinstall.mjs");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(script)).digest("hex"),
    "5a7c990fe552e76b16422cdba3f4b0550590c7a487f7932c773362f74317c87b");
  const log = denyLinks(root, env);
  env.MEMOCAP_LINK_PHASE = "official-host-bootstrap";
  const child = spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 30000 });
  retainLinkEvents(log, { child_status: child.status, control: "actual-official-postinstall" }, `${log}.json`);
  assert.equal(child.status, 0, child.stderr);
  assert.ok(fs.statSync(log).size > 0, "original zero-log assertion is RED for the real official caller");
  const receipt = assertManagedLinks(log);
  assert.equal(receipt.bootstrap_attempted_links, 1);
  assert.equal(linkEvents(log).events[0].pid, child.pid);
  const copied = path.join(hostRoot, "bin/opencode.exe");
  assert.deepEqual(fs.readFileSync(copied), standIn);
  assert.equal(fs.statSync(copied).nlink, 1);
  context.diagnostic("actual official postinstall with an executable stand-in proves caller and copy fallback; actual host acceptance uses the native platform package");
});
