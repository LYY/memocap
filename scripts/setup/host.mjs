import path from "node:path";
import fs from "node:fs";
import { SetupError } from "./arguments.mjs";
import { readJSON } from "./files.mjs";
import { checked, executable, launcherScript } from "./process.mjs";

export function inspectHost(runtime) {
  const filename = executable("opencode", runtime.env);
  if (!filename) throw new SetupError("missing_host", "OpenCode 1.19.3 must already be installed and available on PATH");
  const real = fs.realpathSync(filename);
  const target = /\.(cmd|bat)$/i.test(real) ? launcherScript(real) : real;
  let directory = target && path.dirname(target);
  for (let depth = 0; directory && depth < 7; depth++) {
    const metadata = readJSON(path.join(directory, "package.json"));
    if (metadata && (metadata.name === "opencode-ai" || /^opencode-(darwin|linux|windows)-/.test(metadata.name || ""))) return { executable_path: filename, version: metadata.version, source: path.join(directory, "package.json") };
    const receipt = readJSON(path.join(directory, "INSTALL_RECEIPT.json"));
    if (receipt?.source?.tap === "anomalyco/tap" && path.basename(receipt.source.path || "") === "opencode.rb") return { executable_path: filename, version: receipt.source.versions?.stable, source: path.join(directory, "INSTALL_RECEIPT.json") };
    if (directory === path.dirname(directory)) break;
    directory = path.dirname(directory);
  }
  return { executable_path: filename, version: null, source: "not_run", reason: "No package metadata; --version is deferred to an authorized mutation because OpenCode startup can create state directories" };
}

export async function verifyHost(runtime, host) {
  const version = host.version || await checked(runtime, host.executable_path, ["--version"]);
  if (version !== "1.19.3") throw new SetupError("unsupported_host", `Verified OpenCode version is 1.19.3; found ${version}`);
  return version;
}
