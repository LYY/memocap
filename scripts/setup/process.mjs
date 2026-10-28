import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SetupError } from "./arguments.mjs";
import { readText } from "./files.mjs";

export function launcherScript(program) {
  const real = fs.realpathSync(program);
  const target = readText(real)?.match(/^(?:#|::|rem) cmd-shim-target=(.+)\r?$/mi)?.[1]?.trim();
  if (target) return path.isAbsolute(target) && fs.existsSync(target) ? fs.realpathSync(target) : null;
  return /\.(cmd|bat)$/i.test(real) ? windowsShimScript(real) : real;
}

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
  return windowsShimTarget(program)?.filename || null;
}

function windowsShimTarget(program) {
  const target = readText(program)?.match(/^(?:::|rem) cmd-shim-target=(.+)\r?$/mi)?.[1]?.trim();
  if (target) return path.isAbsolute(target) && fs.existsSync(target) ? { filename: fs.realpathSync(target), interpreter: process.execPath } : null;
  const directory = path.dirname(program);
  const stem = path.basename(program, path.extname(program)).toLowerCase();
  const modules = path.basename(directory) === ".bin" ? path.dirname(directory) : path.join(directory, "node_modules");
  const targets = {
    npm: [path.join(modules, "npm/bin/npm-cli.js")],
    npx: [path.join(modules, "npm/bin/npx-cli.js")],
    memocap: [path.join(modules, "@lyy-gh/memocap/bin/cli.cjs")],
    pnpm: [path.join(modules, "pnpm/bin/pnpm.cjs"), path.join(modules, "pnpm/bin/pnpm.mjs"), path.join(directory, "pnpm.cjs")],
    opencode: [path.join(modules, "opencode-ai/bin/opencode.exe")],
  };
  for (const filename of targets[stem] || []) {
    try { if (fs.statSync(filename).isFile()) return { filename, interpreter: stem === "opencode" ? null : process.execPath }; }
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
      const target = windowsShimTarget(program);
      if (!target) return { code: 126, stdout: "", stderr: `Cannot safely dispatch Windows shim: ${program}` };
      program = target.interpreter || target.filename;
      argumentsList = target.interpreter ? [target.filename, ...args] : args;
    }
  }
  let captureDirectory;
  let stdoutDescriptor;
  try {
    if (options.stdoutFile) {
      captureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "memocap-inventory-"));
      stdoutDescriptor = fs.openSync(path.join(captureDirectory, "stdout"), "wx+", 0o600);
    }
    const execution = await new Promise((resolve, reject) => {
      const child = spawn(program, argumentsList, { cwd: options.cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", stdoutDescriptor ?? "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let forceTimer;
      let exited = false;
      let pendingError;
      const clearTimers = () => { clearTimeout(timer); clearTimeout(forceTimer); clearInterval(captureTimer); };
      const fail = (error) => { pendingError = undefined; clearTimers(); reject(error); };
      const signalGroup = (signal) => {
        try { killTree(child, signal, options.env || process.env); }
        catch (error) {
          if (process.platform === "darwin" && signal === "SIGTERM" && error.code === "EPERM" && !exited) pendingError = error;
          else fail(error);
        }
      };
      const stop = () => {
        if (forceTimer) return;
        forceTimer = setTimeout(() => {
          signalGroup("SIGKILL");
          if (pendingError) fail(pendingError);
        }, 250);
        signalGroup("SIGTERM");
      };
      const timer = setTimeout(stop, options.timeout || 180_000);
      const captureTimer = stdoutDescriptor === undefined ? undefined : setInterval(() => {
        try { if (fs.fstatSync(stdoutDescriptor).size > 4_000_000) stop(); }
        catch (error) { fail(error); }
      }, 25);
      child.stdout?.on("data", (chunk) => { stdout += chunk; if (stdout.length > 4_000_000) stop(); });
      child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 4_000_000) stop(); });
      child.once("exit", () => {
        exited = true;
        if (pendingError) { pendingError = undefined; signalGroup("SIGTERM"); }
      });
      child.once("error", (error) => { clearTimers(); resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }); });
      child.once("close", (code, signal) => {
        if (pendingError) { fail(pendingError); return; }
        clearTimers();
        resolve({ code: forceTimer ? 1 : code ?? 1, stdout, stderr, signal });
      });
    });
    if (stdoutDescriptor !== undefined) {
      const output = Buffer.alloc(Math.min(fs.fstatSync(stdoutDescriptor).size, 4_000_001));
      const length = fs.readSync(stdoutDescriptor, output, 0, output.length, 0);
      execution.stdout = length > 4_000_000 ? "" : output.subarray(0, length).toString("utf8");
      if (length > 4_000_000) execution.code = 1;
    }
    return execution;
  } finally {
    try { if (stdoutDescriptor !== undefined) fs.closeSync(stdoutDescriptor); }
    finally { if (captureDirectory) fs.rmSync(captureDirectory, { recursive: true, force: true }); }
  }
}

export async function checked(runtime, command, args, cwd) {
  const execution = await runtime.run(command, args, { cwd: cwd || runtime.cwd, env: { ...runtime.env, DISABLE_TELEMETRY: "1" } });
  if (execution.code !== 0) throw new SetupError("process_failed", `${command} exited ${execution.code}`, { command, args, stderr: execution.stderr, stdout: execution.stdout });
  return execution.stdout.trim();
}
