import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const { version } = createRequire(import.meta.url)("../package.json");
const bundledLauncher = fileURLToPath(new URL("../bin/cli.cjs", import.meta.url));
const outputLimit = 1024 * 1024;

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message, { cause: details.cause });
    this.name = "BridgeError";
    this.code = code;
    Object.assign(this, details);
  }
}

function validateRequest(argv, { cwd, deadlineMs, signal }) {
  if (!Array.isArray(argv) || argv.length === 0 ||
      argv.some((argument) => typeof argument !== "string" || argument.includes("\0")) ||
      typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0") ||
      !Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2147483647 ||
      (signal !== undefined && !(signal instanceof AbortSignal))) {
    throw new BridgeError("invalid_request", "Expected string argv, absolute cwd, AbortSignal and positive deadlineMs", {
      phase: "handshake", outcome: "not_started",
    });
  }
}

function terminateTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") return Promise.reject(error);
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const killer = spawn(join(process.env.SystemRoot, "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { killer.kill(); reject(new Error("taskkill deadline exceeded")); }, 1000);
    killer.once("error", reject);
    killer.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`taskkill exited with ${code}`));
    });
  });
}

function captureOutput(stream, stop) {
  const chunks = [];
  let bytes = 0;
  stream.on("data", (chunk) => {
    const available = outputLimit - bytes;
    if (available > 0) chunks.push(chunk.subarray(0, available));
    bytes += Math.min(chunk.length, available);
    if (chunk.length > available) stop("output_limit", "CLI output exceeded 1 MiB per stream");
  });
  return () => {
    const text = Buffer.from(Buffer.concat(chunks, bytes).toString("utf8"));
    return new StringDecoder("utf8").write(text.subarray(0, outputLimit));
  };
}

function runProcess(request) {
  return new Promise((resolve, reject) => {
    const { executable, launcher, argv, cwd, signal, expiresAt, phase } = request;
    let child;
    let started = false;
    let failure;
    let cleanup = Promise.resolve();
    let reapTimer;
    const details = () => ({ phase, outcome: phase === "command" && started ? "outcome_unknown" : "not_started" });
    const stop = (code, message, cause) => {
      if (failure) return;
      failure = new BridgeError(code, message, { ...details(), cause });
      if (!child) return;
      cleanup = terminateTree(child).catch((error) => {
        failure = new BridgeError("cleanup_failed", "Could not terminate the CLI process tree", { ...details(), cause: error });
        child.kill("SIGKILL");
      });
      reapTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new BridgeError("cleanup_failed", "CLI did not close after termination", details()));
      }, 1500);
    };
    const abort = () => stop("cancelled", "CLI request cancelled");
    if (signal?.aborted) { abort(); reject(failure); return; }
    if (expiresAt <= Date.now()) { stop("timeout", "CLI deadline exceeded"); reject(failure); return; }
    try {
      child = spawn(executable, [launcher, ...argv], {
        cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      reject(new BridgeError("spawn_failed", "Could not launch bundled CLI", { ...details(), cause }));
      return;
    }
    const stdout = captureOutput(child.stdout, stop);
    const stderr = captureOutput(child.stderr, stop);
    const timer = setTimeout(() => stop("timeout", "CLI deadline exceeded"), Math.max(1, expiresAt - Date.now()));
    signal?.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => { started = true; });
    child.once("error", (cause) => stop("spawn_failed", "Could not launch bundled CLI", cause));
    child.once("close", async (exitCode, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(reapTimer);
      signal?.removeEventListener("abort", abort);
      await cleanup;
      const output = { stdout: stdout(), stderr: stderr(), exitCode, exitSignal };
      if (failure) { Object.assign(failure, output); reject(failure); }
      else resolve({ ...output, ...details() });
    });
  });
}

function checkVersion(actual, phase, output) {
  if (actual !== version) {
    throw new BridgeError("version_mismatch", `Expected memocap ${version}, received ${String(actual)}`, {
      ...output, phase,
    });
  }
}

function parseReceipt(output) {
  let receipt;
  try { receipt = JSON.parse(output.stdout); } catch (cause) {
    throw new BridgeError("invalid_receipt", "CLI did not return JSON", { ...output, phase: "command", cause });
  }
  if (!receipt || Array.isArray(receipt) || receipt.format_version !== 1 ||
      typeof receipt.status !== "string" || receipt.status.length === 0 ||
      (receipt.results !== undefined && !Array.isArray(receipt.results)) ||
      (receipt.targets !== undefined && !Array.isArray(receipt.targets))) {
    throw new BridgeError("invalid_receipt", "Expected format_version 1 receipt with a status", { ...output, phase: "command" });
  }
  if (receipt.package_version !== undefined) checkVersion(receipt.package_version, "command", output);
  return receipt;
}

function commandReceipt(output) {
  if (output.exitCode === 0) return parseReceipt(output);
  let receipt;
  try { receipt = parseReceipt(output); } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== "invalid_receipt") throw error;
  }
  throw new BridgeError("cli_failed", `CLI exited with ${output.exitCode ?? output.exitSignal}`, {
    ...output, receipt, phase: "command", outcome: receipt?.status ?? output.outcome,
  });
}

function supportedNode(runtime) {
  if (typeof runtime.node !== "string" || !/^\d+\.\d+\.\d+$/.test(runtime.node) ||
      typeof runtime.execPath !== "string") return false;
  const [major, minor] = runtime.node.split(".").map(Number);
  return runtime.release === "node" && !runtime.bun && isAbsolute(runtime.execPath) &&
    (major > 22 || (major === 22 && minor >= 20));
}

async function pathNode() {
  const search = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const directory of search.split(delimiter).filter(isAbsolute)) {
    const executable = join(directory, process.platform === "win32" ? "node.exe" : "node");
    try { await access(executable, constants.X_OK); return executable; } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
    }
  }
  throw new BridgeError("runtime_missing", "Node >=22.20 is required on PATH", { phase: "handshake", outcome: "not_started" });
}

async function verifiedNode(executable, request) {
  if (!executable && !process.versions.bun && process.release.name === "node") {
    executable = process.execPath;
  }
  const output = await runProcess({ ...request, executable: executable ?? await pathNode(), launcher: "-e",
    argv: ['console.log(JSON.stringify({release:process.release.name,node:process.versions.node,bun:process.versions.bun,execPath:process.execPath}))'],
    phase: "handshake" });
  let runtime;
  try { runtime = JSON.parse(output.stdout); } catch (cause) {
    throw new BridgeError("runtime_incompatible", "Expected a Node >=22.20 executable", { ...output, cause });
  }
  if (output.exitCode !== 0 || !runtime || !supportedNode(runtime)) {
    throw new BridgeError("runtime_incompatible", "Expected a Node >=22.20 executable", output);
  }
  return runtime.execPath;
}

export function createBridge({ launcher = bundledLauncher, executable } = {}) {
  if (!isAbsolute(launcher) || (executable !== undefined &&
      (!isAbsolute(executable) || /\.(cmd|bat)$/i.test(executable)))) {
    throw new BridgeError("invalid_request", "Launcher and executable must be absolute paths");
  }
  let nodeExecutable;
  return {
    async run(argv, { cwd, signal, deadlineMs = 3000 } = {}) {
      validateRequest(argv, { cwd, deadlineMs, signal });
      const expiresAt = Date.now() + deadlineMs;
      try { await access(launcher); } catch (cause) {
        throw new BridgeError("launcher_missing", "Bundled CLI launcher is unavailable", {
          phase: "handshake", outcome: "not_started", cause,
        });
      }
      nodeExecutable ??= await verifiedNode(executable, { cwd, signal, expiresAt });
      const request = { executable: nodeExecutable, launcher, cwd, signal, expiresAt };
      const handshake = await runProcess({ ...request, argv: ["--version"], phase: "handshake" });
      if (handshake.exitCode !== 0) {
        throw new BridgeError("cli_failed", "CLI version handshake failed", handshake);
      }
      checkVersion(/^memocap\s+(\S+)\s*$/.exec(handshake.stdout)?.[1], "handshake", handshake);
      const commandArgv = argv.includes("--json") ? [...argv] : [...argv, "--json"];
      const output = await runProcess({ ...request, argv: commandArgv, phase: "command" });
      return { receipt: commandReceipt(output), stderr: output.stderr, exitCode: output.exitCode };
    },
  };
}

export const run = createBridge().run;
