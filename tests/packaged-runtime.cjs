"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function write(filename, contents) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function isolatedEnvironment(root) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH = process.platform === "win32" ? [path.dirname(process.execPath),
    path.join(env.SystemRoot, "System32"), env.SystemRoot,
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git/cmd"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git/usr/bin")].join(path.delimiter) : "/usr/bin:/bin:/usr/sbin:/sbin";
  Object.assign(env, {
    HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "home/config"), XDG_CACHE_HOME: path.join(root, "home/cache"),
    XDG_DATA_HOME: path.join(root, "home/data"), XDG_STATE_HOME: path.join(root, "home/state"),
    APPDATA: path.join(root, process.platform === "win32" ? "home/AppData/Roaming" : "home/appdata"),
    LOCALAPPDATA: path.join(root, process.platform === "win32" ? "home/AppData/Local" : "home/local"),
    TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    MEMOCAP_DB: path.join(root, "memory/core.db"), MEMOCAP_DATA_DIR: path.join(root, "memory"),
    npm_config_prefix: path.join(root, "prefix"), npm_config_cache: path.join(root, "npm-cache"),
    npm_config_userconfig: path.join(root, "npmrc"), npm_config_globalconfig: path.join(root, "global-npmrc"),
    npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0",
    CI: "true", DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  });
  for (const directory of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME,
    env.XDG_STATE_HOME, env.APPDATA, env.LOCALAPPDATA, env.TMPDIR, env.MEMOCAP_DATA_DIR, env.npm_config_prefix]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return env;
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

function mergeHostConfig(filename, settings) {
  const jsonc = require("jsonc-parser");
  let text = fs.readFileSync(filename, "utf8");
  const previous = jsonc.parse(text);
  const merged = { ...previous, ...settings, provider: { ...previous.provider, ...settings.provider } };
  for (const key of [...Object.keys(settings), "provider"]) {
    text = jsonc.applyEdits(text, jsonc.modify(text, [key], merged[key], { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  write(filename, text);
  assert.deepEqual(jsonc.parse(fs.readFileSync(filename, "utf8")), merged);
}

function denyLinks(root, env) {
  const log = path.join(root, "denied-links.jsonl");
  const preload = path.join(root, "deny-links.cjs");
  write(preload, `const fs = require('node:fs');
const denied = (name) => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ api: name }) + '\\n');
  return Object.assign(new Error('fixture denies link creation'), { code: 'EPERM' });
};
for (const name of ['symlink', 'link']) {
  fs[name + 'Sync'] = () => { throw denied(name + 'Sync'); };
  fs[name] = (...args) => args.at(-1)(denied(name));
  fs.promises[name] = async () => { throw denied('promises.' + name); };
}
`);
  env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  return log;
}

function runner(env, evidence, active, defaultCwd) {
  return async (executable, args, options = {}) => {
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: options.cwd || defaultCwd,
        env: { ...env, ...options.env }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      active.add(child);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; terminate(child); }, options.timeout || 180000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => { clearTimeout(timer); active.delete(child); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer); active.delete(child); resolve({ code, signal, stdout, stderr, timedOut });
      });
    });
    evidence.commands.push({ executable: path.basename(executable), args, code: result.code,
      elapsed_ms: Date.now() - started, stdout_bytes: Buffer.byteLength(result.stdout),
      stderr_bytes: Buffer.byteLength(result.stderr), ...(result.timedOut ? { timed_out: true } : {}) });
    if (!options.allowFailure) assert.equal(result.code, 0,
      `${path.basename(executable)} ${args.join(" ")}: ${result.stderr.slice(-4000)} ${result.stdout.slice(-4000)}`);
    return result;
  };
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch (error) { if (error.code !== "ESRCH") throw error; }
}

module.exports = { digest, write, snapshot, isolatedEnvironment, mergeHostConfig, denyLinks, runner, terminate };
