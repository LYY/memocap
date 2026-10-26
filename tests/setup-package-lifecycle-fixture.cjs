"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { digest, write, snapshot, isolatedEnvironment, denyLinks, assertManagedLinks, retainLinkEvents, runner, terminate } = require("./packaged-runtime.cjs");

function lifecycleFixture(workspace, evidence) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap packaged acceptance "));
  const env = isolatedEnvironment(root);
  const home = env.HOME;
  const prefix = env.npm_config_prefix;
  const project = path.join(root, "project with spaces");
  const localSkillProject = path.join(root, "optional skill project");
  const tools = path.join(root, "tools");
  const guards = path.join(root, "guard-bin");
  const runtimeBin = path.join(root, "runtime-bin");
  const guardLog = path.join(root, "forbidden-skills.jsonl");
  const deniedLinks = process.platform === "win32" ? denyLinks(root, env) : undefined;
  env.MEMOCAP_LINK_PHASE = "current-managed";
  const version = JSON.parse(fs.readFileSync(path.join(workspace, "package.json"))).version;
  const installedRoot = path.join(prefix, process.platform === "win32" ? "node_modules/@lyy-gh/memocap" : "lib/node_modules/@lyy-gh/memocap");
  const npmCli = process.platform === "win32" ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") :
    fs.realpathSync(path.join(path.dirname(process.execPath), "npm"));
  const active = new Set();
  const run = runner(env, evidence, active, project);
  let server;
  let payload;
  let tarball;
  let host;
  for (const directory of [project, localSkillProject, tools, guards, runtimeBin]) fs.mkdirSync(directory, { recursive: true });
  if (process.platform !== "win32") {
    fs.symlinkSync(process.execPath, path.join(runtimeBin, "node"));
    fs.symlinkSync(npmCli, path.join(runtimeBin, "npm"));
    fs.symlinkSync(path.join(path.dirname(npmCli), "npx-cli.js"), path.join(runtimeBin, "npx"));
  }
  env.PATH = [guards, process.platform === "win32" ? prefix : path.join(prefix, "bin"),
    process.platform === "win32" ? tools : path.join(tools, "bin"), runtimeBin, env.PATH].join(path.delimiter);

  async function command(executable, args, options) {
    let result;
    if (executable === "npm") result = await run(process.execPath, [npmCli, ...args], options);
    else if (executable === "memocap") result = await run(process.execPath, [path.join(installedRoot, "bin/cli.cjs"), ...args], options);
    else if (executable === "memocap-setup") result = await run(process.execPath, [path.join(installedRoot, "scripts/setup.mjs"), ...args], options);
    else result = await run(executable, args, options);
    if (deniedLinks) assertManagedLinks(deniedLinks);
    return result;
  }

  async function prepare() {
    const native = path.resolve(process.env.MEMOCAP_TEST_NATIVE || path.join(workspace, "target/debug", process.platform === "win32" ? "memocap.exe" : "memocap"));
    const nativeVersion = (await run(native, ["--version"])).stdout.trim();
    assert.equal(nativeVersion, `memocap ${version}`, "build the current native version before packaging");
    evidence.native = { version: nativeVersion, sha256: digest(fs.readFileSync(native)),
      origin: "actual_current_platform_local_build_not_published_release_asset" };
    if (process.env.MEMOCAP_TEST_TARBALL) tarball = path.resolve(process.env.MEMOCAP_TEST_TARBALL);
    else {
      const packed = JSON.parse((await command("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: workspace })).stdout)[0];
      tarball = path.join(root, packed.filename);
    }
    const bytes = fs.readFileSync(tarball);
    const unpacked = path.join(root, "unpacked");
    fs.mkdirSync(unpacked);
    await run("tar", ["-xzf", tarball, "-C", unpacked]);
    payload = path.join(unpacked, "package");
    assert.equal(JSON.parse(fs.readFileSync(path.join(payload, "package.json"))).version, version);
    for (const filename of ["lib/policy.mjs", "plugin/policy.js", "scripts/setup/policy.mjs", "skills/memocap/SKILL.md"]) {
      assert.ok(fs.existsSync(path.join(payload, filename)), `tarball missing ${filename}`);
    }
    evidence.pack = { version, sha256: digest(bytes), bytes: bytes.length,
      source: "actual_npm_pack_ignore_scripts", integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` };
    evidence.pack.files = fs.readdirSync(payload, { recursive: true })
      .filter((relative) => fs.lstatSync(path.join(payload, relative)).isFile())
      .map((relative) => ({ path: relative.split(path.sep).join("/"),
        bytes: fs.statSync(path.join(payload, relative)).size, sha256: digest(fs.readFileSync(path.join(payload, relative))) }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    evidence.source = { package_json_sha256: digest(fs.readFileSync(path.join(workspace, "package.json"))),
      cargo_toml_sha256: digest(fs.readFileSync(path.join(workspace, "Cargo.toml"))),
      commit: process.env.GITHUB_SHA || null,
      freeze: process.env.GITHUB_SHA ? "fixed_ci_checkout" : process.env.MEMOCAP_TEST_SOURCE_FROZEN === "1" ? "confirmed_by_parent" : "candidate_not_confirmed" };
    const requests = [];
    server = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (request.url === "/memocap.tgz") { response.writeHead(200); response.end(bytes); return; }
      if (decodeURIComponent(request.url).startsWith("/@lyy-gh/memocap")) {
        const metadata = { ...JSON.parse(fs.readFileSync(path.join(payload, "package.json"))), dist: {
          tarball: `http://127.0.0.1:${server.address().port}/memocap.tgz`, integrity: evidence.pack.integrity } };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: metadata.name, "dist-tags": { latest: version }, versions: { [version]: metadata } }));
      } else { response.writeHead(302, { location: `https://registry.npmjs.org${request.url}` }); response.end(); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    env.npm_config_registry = `http://127.0.0.1:${server.address().port}`;
    evidence.registry_requests = requests;
    await command("npm", ["install", "--global", "--prefix", tools, "opencode-ai@1.19.3", "--registry", "https://registry.npmjs.org"],
      { env: { MEMOCAP_LINK_PHASE: "official-host-bootstrap" } });
    const hostRoot = path.join(tools, process.platform === "win32" ? "node_modules" : "lib/node_modules");
    const hostPlatform = { "darwin-arm64": "opencode-darwin-arm64", "linux-x64": "opencode-linux-x64", "win32-x64": "opencode-windows-x64" }[`${process.platform}-${process.arch}`];
    host = path.join(hostRoot, "opencode-ai/node_modules", hostPlatform, "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
    if (!fs.existsSync(host)) host = path.join(hostRoot, hostPlatform, "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
    assert.ok(fs.existsSync(host), `official native host missing: ${host}`);
    assert.equal((await run(host, ["--version"])).stdout.trim(), "1.19.3");
    evidence.host = { version: "1.19.3", sha256: digest(fs.readFileSync(host)), origin: "official_opencode_ai_npm_platform_dependency" };
    const asset = { "darwin-arm64": "memocap-aarch64-apple-darwin", "linux-x64": "memocap-x86_64-unknown-linux-gnu", "win32-x64": "memocap-x86_64-pc-windows-msvc.exe" }[`${process.platform}-${process.arch}`];
    const cacheBase = process.platform === "darwin" ? path.join(home, "Library/Caches") : process.platform === "win32" ? env.LOCALAPPDATA : env.XDG_CACHE_HOME;
    const cached = path.join(cacheBase, "memocap", version, asset);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.copyFileSync(native, cached);
    fs.chmodSync(cached, 0o755);
    write(`${cached}.sha256`, `${evidence.native.sha256}  ${asset}\n`);
    const script = `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(guardLog)},JSON.stringify(process.argv.slice(2))+'\\n');process.stderr.write('default managed lifecycle must not invoke skills/npx\\n');process.exit(93);\n`;
    for (const name of ["skills", "npx"]) {
      write(path.join(guards, `${name}.cjs`), script);
      write(path.join(guards, process.platform === "win32" ? `${name}.cmd` : name), process.platform === "win32" ? `@"${process.execPath}" "%~dp0${name}.cjs" %*\r\n` : script);
      if (process.platform !== "win32") fs.chmodSync(path.join(guards, name), 0o755);
    }
    const runnerPrefix = path.join(root, "runner");
    await command("npm", ["install", "--prefix", runnerPrefix, "--ignore-scripts", tarball]);
    return { payload, tarball, runnerRoot: path.join(runnerPrefix, "node_modules/@lyy-gh/memocap"), host };
  }

  async function cleanup() {
    for (const child of active) terminate(child);
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (deniedLinks) retainLinkEvents(deniedLinks, evidence,
      process.env.MEMOCAP_TEST_HOST_EVIDENCE || process.env.MEMOCAP_TEST_LIFECYCLE_EVIDENCE ||
      path.join(workspace, ".omo/evidence/memocap-unified-skill/task-8-lifecycle.json"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { sandbox_removed: !fs.existsSync(root), registry_closed: !server?.listening,
      active_children: active.size, personal_config_or_memory_used: false };
  }

  return { root, home, prefix, project, localSkillProject, env, command, prepare, cleanup, installedRoot,
    version, guardLog, deniedLinks, npmCli, get host() { return host; }, get tarball() { return tarball; }, get payload() { return payload; } };
}

module.exports = { lifecycleFixture, digest, write, snapshot };
