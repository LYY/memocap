import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { SetupError } from "./arguments.mjs";

export function executable(name, env) {
  const extensions = process.platform === "win32" ? (/\.(exe|cmd|bat)$/i.test(name) ? [""] : [".exe", ".cmd", ".bat"]) : [""];
  const pathKey = process.platform === "win32" ? Object.keys(env).sort().find((key) => key.toUpperCase() === "PATH") : "PATH";
  for (const directory of (env[pathKey] || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const filename = path.join(directory, name + extension);
      try { fs.accessSync(filename, fs.constants.X_OK); if (fs.statSync(filename).isFile()) return filename; }
      catch (error) { if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error; }
    }
  }
  return null;
}

export function windowsShimScript(program) {
  const directory = path.dirname(program);
  const stem = path.basename(program, path.extname(program)).toLowerCase();
  const modules = path.basename(directory) === ".bin" ? path.dirname(directory) : path.join(directory, "node_modules");
  const scripts = {
    npm: [path.join(modules, "npm/bin/npm-cli.js")],
    npx: [path.join(modules, "npm/bin/npx-cli.js")],
    memocap: [path.join(modules, "@lyy-gh/memocap/bin/cli.cjs")],
    pnpm: [path.join(modules, "pnpm/bin/pnpm.cjs"), path.join(directory, "pnpm.cjs")],
  };
  for (const filename of scripts[stem] || []) {
    try { if (fs.statSync(filename).isFile()) return filename; }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  }
  return null;
}

function killTree(child, signal, env) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const taskkill = spawn(path.join(env.SystemRoot || "C:/Windows", "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    taskkill.once("error", () => child.kill("SIGKILL"));
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

export async function runProcess(command, args, options = {}) {
  const env = { ...(options.env || process.env) };
  delete env.npm_config_package;
  delete env.NPM_CONFIG_PACKAGE;
  let program = command;
  let argumentsList = args;
  if (process.platform === "win32") {
    program = path.isAbsolute(command) ? command : executable(command, env);
    if (!program) return { code: 127, stdout: "", stderr: `Executable not found: ${command}` };
    if (/\.(cmd|bat)$/i.test(program)) {
      const script = windowsShimScript(program);
      if (!script) return { code: 126, stdout: "", stderr: `Cannot safely dispatch Windows shim: ${program}` };
      program = process.execPath;
      argumentsList = [script, ...args];
    }
  }
  return new Promise((resolve) => {
    const child = spawn(program, argumentsList, { cwd: options.cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let forceTimer;
    const stop = () => {
      if (forceTimer) return;
      killTree(child, "SIGTERM", options.env || process.env);
      forceTimer = setTimeout(() => killTree(child, "SIGKILL", options.env || process.env), 250);
    };
    const timer = setTimeout(stop, options.timeout || 180_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 4_000_000) stop(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 4_000_000) stop(); });
    child.once("error", (error) => { clearTimeout(timer); clearTimeout(forceTimer); resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }); });
    child.once("close", (code, signal) => { clearTimeout(timer); clearTimeout(forceTimer); resolve({ code: forceTimer ? 1 : code ?? 1, stdout, stderr, signal }); });
  });
}

export async function checked(runtime, command, args, cwd) {
  const execution = await runtime.run(command, args, { cwd: cwd || runtime.cwd, env: { ...runtime.env, DISABLE_TELEMETRY: "1" } });
  if (execution.code !== 0) throw new SetupError("process_failed", `${command} exited ${execution.code}`, { command, args, stderr: execution.stderr, stdout: execution.stdout });
  return execution.stdout.trim();
}
