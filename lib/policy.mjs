import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectWindowsMetadata } from "./windows-policy-metadata.mjs";

const begin = "<!-- memocap:begin -->";
const end = "<!-- memocap:end -->";

export class PolicyError extends Error {
  constructor(code, message, filename) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
    this.path = filename;
  }
}

function payloadStat(filename) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new PolicyError("policy_file_type", `Expected a regular policy file or directory: ${filename}`, filename);
  }
  return stat;
}

function policyRules(bytes, mainPath) {
  const main = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const start = main.indexOf(begin);
  const finish = main.indexOf(end);
  const markers = main.match(/<!--\s*memocap:/g) || [];
  if (markers.length !== 2 || start < 0 || finish < start || !main.slice(start + begin.length, finish).trim()) {
    throw new PolicyError("policy_markers", `Expected one nonempty memocap marker block: ${mainPath}`, mainPath);
  }
  return main.slice(start, finish + end.length);
}

export function inspectPolicy(directory) {
  const absolute = path.resolve(directory);
  if (!payloadStat(absolute).isDirectory()) throw new PolicyError("policy_file_type", `Expected a policy directory: ${absolute}`, absolute);
  if (process.platform === "win32") {
    let reparse;
    try { reparse = inspectWindowsMetadata(absolute); }
    catch (error) {
      const failure = new PolicyError("policy_reparse_check_failed", error.message, absolute);
      failure.cause = error;
      throw failure;
    }
    if (reparse !== null) throw new PolicyError("policy_file_type", `Reparse point in policy payload: ${reparse}`, reparse);
  }
  const root = fs.realpathSync(absolute);
  const mainPath = path.join(root, "SKILL.md");
  const files = [];
  let main;
  function walk(current, relative) {
    for (const name of fs.readdirSync(current)) {
      const filename = path.join(current, name);
      const local = relative ? `${relative}/${name}` : name;
      const stat = payloadStat(filename);
      if (stat.isDirectory()) walk(filename, local);
      else {
        const bytes = fs.readFileSync(filename);
        files.push({ path: local, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        if (local === "SKILL.md") main = bytes;
      }
    }
  }
  walk(root, "");
  if (main === undefined) {
    fs.lstatSync(mainPath);
    throw new PolicyError("policy_file_type", `Expected a regular policy main file: ${mainPath}`, mainPath);
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { directory: root, mainPath, digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files, rules: policyRules(main, mainPath) };
}
