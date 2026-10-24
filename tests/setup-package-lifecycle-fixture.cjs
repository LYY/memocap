"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function write(filename, contents) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function snapshot(roots) {
  const entries = {};
  function visit(filename) {
    if (!fs.existsSync(filename)) return;
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) entries[filename] = `symlink:${fs.readlinkSync(filename)}`;
    else if (stat.isDirectory()) {
      entries[filename] = "directory";
      for (const name of fs.readdirSync(filename).sort()) visit(path.join(filename, name));
    } else entries[filename] = digest(fs.readFileSync(filename));
  }
  roots.forEach(visit);
  return entries;
}

function lifecycleFixture(workspace, evidence) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memocap packed lifecycle "));
  const home = path.join(root, "home");
  const prefix = path.join(root, "package prefix");
  const tools = path.join(root, "tools");
  const bins = path.join(root, "boundary bin");
  const project = path.join(root, "project with spaces ' $() ; literal");
  const localSkillProject = path.join(root, "local payload project");
  const packageVersion = require(path.join(workspace, "package.json")).version;
  const binary = path.join(root, `local native ${packageVersion}`);
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"), XDG_DATA_HOME: path.join(home, "data"), TMPDIR: path.join(root, "tmp"),
    PATH: [bins, path.join(prefix, "bin"), path.join(tools, "bin"), "/usr/bin", "/bin"].join(path.delimiter),
    npm_config_prefix: prefix, npm_config_cache: path.join(root, "npm cache"), npm_config_userconfig: path.join(root, "npmrc"),
    npm_config_globalconfig: path.join(root, "global-npmrc"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", CI: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    GIT_MASTER: "1", GIT_TERMINAL_PROMPT: "0", MEMOCAP_DB: path.join(home, "memory/core.db"), LANG: "en_US.UTF-8" };
  const active = new Set();
  let server;

  async function command(executable, args, options = {}) {
    const cwd = options.cwd || project;
    const started = Date.now();
    const receipt = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, env: { ...env, ...options.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      active.add(child);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 120_000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); active.delete(child); reject(error); });
      child.on("close", (code, signal) => { clearTimeout(timer); active.delete(child); resolve({ pid: child.pid, code, signal, stdout, stderr }); });
    });
    evidence.commands.push({ executable, args, cwd, ...receipt, elapsed_ms: Date.now() - started });
    if (!options.allowFailure) assert.equal(receipt.code, 0, `${executable} ${args.join(" ")}\n${receipt.stderr}\n${receipt.stdout}`);
    return receipt;
  }

  async function prepare() {
    assert.equal(process.platform, "darwin");
    assert.equal(process.arch, "arm64");
    assert.equal(Number(process.versions.node.split(".")[0]), 24);
    for (const directory of [home, prefix, tools, bins, project, localSkillProject, env.TMPDIR]) fs.mkdirSync(directory, { recursive: true });
    const toolPaths = { node: process.execPath, npm: path.join(path.dirname(process.execPath), "npm"), npx: path.join(path.dirname(process.execPath), "npx"), git: "/opt/homebrew/bin/git" };
    for (const name of ["node", "npm", "npx"]) fs.symlinkSync(fs.realpathSync(toolPaths[name]), path.join(bins, name));
    evidence.tools = Object.fromEntries(Object.entries(toolPaths).map(([name, filename]) => [name, fs.realpathSync(filename)]));
    fs.copyFileSync(path.join(workspace, "target/debug/memocap"), binary);
    fs.chmodSync(binary, 0o755);
    evidence.binary = { source: "target/debug/memocap", sha256: digest(fs.readFileSync(binary)), origin: "prepublish_local" };
    const version = await command(binary, ["--version"]);
    assert.equal(version.stdout.trim(), `memocap ${packageVersion}`);
    const packed = await command("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: workspace });
    const metadata = JSON.parse(packed.stdout)[0];
    const tarball = path.join(root, metadata.filename);
    const bytes = fs.readFileSync(tarball);
    evidence.pack = { ...metadata, sha256: digest(bytes) };
    const unpack = path.join(root, "unpacked tarball");
    fs.mkdirSync(unpack);
    await command("tar", ["-xzf", tarball, "-C", unpack]);
    const payload = path.join(unpack, "package");
    const source = path.join(root, "release fixture");
    fs.mkdirSync(source);
    fs.cpSync(path.join(payload, "skills"), path.join(source, "skills"), { recursive: true });
    const git = toolPaths.git;
    await command(git, ["init", "--quiet", source]);
    await command(git, ["-C", source, "add", "skills"]);
    await command(git, ["-C", source, "-c", "user.name=Sandbox Fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Unpacked tarball skill fixture"]);
    await command(git, ["-C", source, "tag", `v${packageVersion}`]);
    write(env.GIT_CONFIG_GLOBAL, `[url "file://${source}/"]\n  insteadOf = https://github.com/LYY/memocap.git\n[protocol "file"]\n  allow = always\n`);
    const failClone = path.join(root, "fail clone");
    const gitLog = path.join(root, "git calls.jsonl");
    write(path.join(bins, "git"), `#!${process.execPath}\nconst fs=require('node:fs');const {spawnSync}=require('node:child_process');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(gitLog)},JSON.stringify(args)+'\\n');if(args.includes('clone')&&fs.existsSync(${JSON.stringify(failClone)})){process.stderr.write('sandbox unpublished release transport failure\\n');process.exit(73);}const child=spawnSync(${JSON.stringify(git)},args,{stdio:'inherit',env:process.env});process.exit(child.status??1);\n`);
    fs.chmodSync(path.join(bins, "git"), 0o755);
    const requests = [];
    server = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (request.url === "/memocap.tgz") { response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(bytes); return; }
      if (decodeURIComponent(request.url).startsWith("/@lyy-gh/memocap")) {
        const versionMetadata = { ...JSON.parse(fs.readFileSync(path.join(payload, "package.json"))), dist: {
          tarball: `http://127.0.0.1:${server.address().port}/memocap.tgz`, integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` } };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: "@lyy-gh/memocap", "dist-tags": { latest: packageVersion }, versions: { [packageVersion]: versionMetadata } }));
      } else { response.writeHead(302, { location: `https://registry.npmjs.org${request.url}` }); response.end(); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    env.npm_config_registry = `http://127.0.0.1:${server.address().port}`;
    evidence.registry_requests = requests;
    await command("npm", ["install", "--global", "--prefix", tools, "opencode-ai@1.19.3", "--registry", "https://registry.npmjs.org"]);
    await command("opencode", ["--version"]);
    const cache = path.join(home, "Library/Caches/memocap", packageVersion);
    const asset = "memocap-aarch64-apple-darwin";
    fs.mkdirSync(cache, { recursive: true });
    fs.copyFileSync(binary, path.join(cache, asset));
    write(path.join(cache, `${asset}.sha256`), `${evidence.binary.sha256}  ${asset}\n`);
    return { payload, failClone, gitLog };
  }

  async function cleanup() {
    for (const child of active) process.kill(-child.pid, "SIGKILL");
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    return { sandbox: root, sandbox_removed: !fs.existsSync(root), loopback_server_closed: !server?.listening,
      active_children: active.size, personal_config_or_memory_used: false,
      git_writes: "GIT_MASTER=1; sandbox release fixture refs only; no worktree/index/branch changes in user repository" };
  }

  return { root, home, prefix, project, localSkillProject, env, command, prepare, cleanup };
}

module.exports = { lifecycleFixture, digest, write, snapshot };
