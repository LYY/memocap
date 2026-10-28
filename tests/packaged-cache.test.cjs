"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isolatedEnvironment, runner, terminate, write } = require("./packaged-runtime.cjs");

function sandbox(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap download cache "));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("default isolation ignores inherited npm cache, config, tokens and fixture opt-in", async (context) => {
  const root = sandbox(context);
  const run = runner({ ...isolatedEnvironment(root), npm_config_cache: "/personal/cache",
    NPM_CONFIG_CACHE: "/personal/uppercase-cache", npm_config_userconfig: "/personal/npmrc",
    NPM_TOKEN: "personal-token", NODE_AUTH_TOKEN: "personal-auth",
    MEMOCAP_TEST_NPM_CACHE: "/unrequested/cache" }, { commands: [] }, new Set(), root);
  const result = await run(process.execPath, ["-e", `
    const { isolatedEnvironment } = require(${JSON.stringify(require.resolve("./packaged-runtime.cjs"))});
    console.log(JSON.stringify(isolatedEnvironment(process.argv[1])));
  `, root]);
  const env = JSON.parse(result.stdout);
  assert.equal(env.npm_config_cache, path.join(root, "npm-cache"));
  assert.equal(env.npm_config_userconfig, path.join(root, "npmrc"));
  assert.equal(env.npm_config_globalconfig, path.join(root, "global-npmrc"));
  for (const key of ["NPM_CONFIG_CACHE", "NPM_TOKEN", "NODE_AUTH_TOKEN", "MEMOCAP_TEST_NPM_CACHE",
    "npm_config_prefer_offline", "npm_config_offline"]) assert.equal(env[key], undefined, key);
});

test("explicit cache reuse leaves all other persistent state in distinct sandboxes", (context) => {
  const root = sandbox(context);
  const cache = path.join(root, "shared-downloads");
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  const first = isolatedEnvironment(firstRoot, cache);
  const second = isolatedEnvironment(secondRoot, cache);
  assert.equal(first.npm_config_cache, cache);
  assert.equal(second.npm_config_cache, cache);
  assert.equal(first.npm_config_prefer_offline, "true");
  assert.equal(second.npm_config_prefer_offline, "true");
  assert.equal(first.npm_config_offline, undefined);
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
    "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP", "MEMOCAP_DB",
    "MEMOCAP_DATA_DIR", "npm_config_prefix", "npm_config_userconfig", "npm_config_globalconfig",
    "GIT_CONFIG_GLOBAL"]) {
    assert.ok(first[key].startsWith(firstRoot + path.sep), key);
    assert.ok(second[key].startsWith(secondRoot + path.sep), key);
    assert.notEqual(first[key], second[key], key);
  }
});

test("lifecycle fixture opts in explicitly and cleanup retains externally owned cache", async (context) => {
  const root = sandbox(context);
  const cache = path.join(root, "downloads");
  write(path.join(cache, "sentinel"), "owner bytes");
  const env = { ...isolatedEnvironment(root), MEMOCAP_TEST_NPM_CACHE: cache,
    MEMOCAP_TEST_LIFECYCLE_EVIDENCE: path.join(root, "links.json") };
  const run = runner(env, { commands: [] }, new Set(), root);
  const result = await run(process.execPath, ["-e", `
    const { lifecycleFixture } = require(${JSON.stringify(require.resolve("./setup-package-lifecycle-fixture.cjs"))});
    (async () => {
      const fixture = lifecycleFixture(process.argv[1], { commands: [] });
      try { console.log(JSON.stringify({ env: fixture.env, root: fixture.root, project: fixture.project })); }
      finally { await fixture.cleanup(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, path.resolve(__dirname, "..")]);
  const fixture = JSON.parse(result.stdout);
  assert.equal(fixture.env.npm_config_cache, cache);
  assert.equal(fixture.env.npm_config_prefer_offline, "true");
  assert.equal(fixture.env.npm_config_offline, undefined);
  assert.ok(fixture.project.startsWith(fixture.root + path.sep));
  assert.equal(fs.existsSync(fixture.root), false);
  assert.equal(fs.readFileSync(path.join(cache, "sentinel"), "utf8"), "owner bytes");
});

test("a fresh prefix installs verified dependency bytes offline using only the shared download cache", async (context) => {
  const root = sandbox(context);
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  const cache = path.join(root, "downloads");
  const first = isolatedEnvironment(firstRoot, cache);
  const second = isolatedEnvironment(secondRoot, cache);
  const active = new Set();
  const evidence = { commands: [] };
  const npmCli = process.platform === "win32" ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") :
    fs.realpathSync(path.join(path.dirname(process.execPath), "npm"));
  const runFirst = runner(first, evidence, active, firstRoot);
  const runSecond = runner(second, evidence, active, secondRoot);
  const source = path.join(root, "source");
  const manifest = { name: "memocap-cache-proof", version: "1.0.0", main: "index.js" };
  const contents = "module.exports = 'verified download cache bytes';\n";
  write(path.join(source, "package.json"), JSON.stringify(manifest));
  write(path.join(source, "index.js"), contents);
  let server;
  context.after(async () => {
    for (const child of active) terminate(child);
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  const pack = runner(isolatedEnvironment(path.join(root, "packing")), evidence, active, source);
  const packed = JSON.parse((await pack(process.execPath,
    [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: source })).stdout)[0];
  const archive = path.join(root, packed.filename);
  const bytes = fs.readFileSync(archive);
  const requests = [];
  server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/proof.tgz") { response.end(bytes); return; }
    if (request.url !== "/memocap-cache-proof") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: manifest.name, "dist-tags": { latest: "1.0.0" }, versions: {
      "1.0.0": { ...manifest, dist: { tarball: `http://127.0.0.1:${server.address().port}/proof.tgz`,
        integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` } },
    } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  first.npm_config_registry = second.npm_config_registry = `http://127.0.0.1:${server.address().port}`;
  const install = [npmCli, "install", "--global", "--ignore-scripts", "memocap-cache-proof@1.0.0"];
  const relative = process.platform === "win32" ? "node_modules/memocap-cache-proof" : "lib/node_modules/memocap-cache-proof";
  const firstPackage = path.join(first.npm_config_prefix, relative);
  const secondPackage = path.join(second.npm_config_prefix, relative);
  await runFirst(process.execPath, install);
  assert.ok(requests.includes("/memocap-cache-proof"), "initial install fetched registry metadata");
  assert.ok(requests.includes("/proof.tgz"), "initial install downloaded package tarball");
  assert.equal(fs.readFileSync(path.join(firstPackage, "index.js"), "utf8"), contents);
  assert.deepEqual(fs.readdirSync(second.npm_config_prefix), []);
  const requestCount = requests.length;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(firstRoot, { recursive: true });
  fs.rmSync(source, { recursive: true });
  fs.rmSync(archive);
  await runSecond(process.execPath, [...install, "--offline"]);
  assert.equal(requests.length, requestCount);
  assert.equal(fs.existsSync(firstRoot), false);
  assert.equal(fs.lstatSync(secondPackage).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(secondPackage, "index.js"), "utf8"), contents);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(secondPackage, "package.json"))), manifest);
  const loaded = await runSecond(process.execPath, ["-e", "console.log(require(process.argv[1]))", secondPackage]);
  assert.equal(loaded.stdout.trim(), "verified download cache bytes");
  context.diagnostic("real npm pack, registry download, registry shutdown, first prefix removal, fresh offline install and module execution verified");
});
