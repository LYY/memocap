import fs from "node:fs";
import path from "node:path";
import { inspectPolicy, PolicyError } from "../../lib/policy.mjs";
import { exactVersion, SetupError } from "./arguments.mjs";

export function policyDirectory(scope, runtime, target, digest) {
  exactVersion(target);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new SetupError("policy_digest", "Expected a full lowercase SHA-256 policy digest");
  const paths = runtime.platform === "win32" ? path.win32 : path.posix;
  let root;
  if (scope.kind === "project") root = paths.resolve(scope.directory, ".opencode");
  else if (scope.kind === "global") {
    const home = runtime.env.HOME || runtime.env.USERPROFILE;
    root = runtime.env.OPENCODE_CONFIG_DIR
      ? paths.resolve(runtime.cwd, runtime.env.OPENCODE_CONFIG_DIR)
      : paths.resolve(runtime.cwd, runtime.env.XDG_CONFIG_HOME || paths.join(home, ".config"), "opencode");
  } else throw new SetupError("policy_scope", `Unknown policy scope: ${scope.kind}`);
  return paths.join(root, "memocap", "policies", `${target}-${digest}`, "memocap");
}

function existingPolicy(destination, digest) {
  try { fs.lstatSync(destination); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const policy = inspectPolicy(destination);
  if (policy.digest !== digest) throw new PolicyError("policy_collision", `Existing policy differs: ${destination}`, destination);
  return { ...policy, status: "unchanged" };
}

export function copyPolicy(source, destination, expectedDigest) {
  const policy = inspectPolicy(source);
  if (policy.digest !== expectedDigest) throw new PolicyError("policy_digest", `Source policy changed: ${source}`, source);
  const existing = existingPolicy(destination, expectedDigest);
  if (existing) return existing;
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, ".memocap-policy-"));
  const payload = path.join(staging, "memocap");
  try {
    fs.cpSync(policy.directory, payload, { recursive: true, dereference: false, errorOnExist: true, force: false });
    if (inspectPolicy(payload).digest !== expectedDigest) throw new PolicyError("policy_digest", `Staged policy differs: ${payload}`, payload);
    const concurrent = existingPolicy(destination, expectedDigest);
    if (concurrent) return concurrent;
    try { fs.renameSync(payload, destination); }
    catch (error) {
      const collision = existingPolicy(destination, expectedDigest);
      if (collision) return collision;
      throw error;
    }
    const installed = inspectPolicy(destination);
    if (installed.digest !== expectedDigest) throw new PolicyError("policy_digest", `Installed policy changed: ${destination}`, destination);
    return { ...installed, status: "changed" };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
