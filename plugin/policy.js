import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPolicy, PolicyError } from "../lib/policy.mjs";
import { packageVersion } from "./protocol.js";

const organizationPointers = new WeakMap();

export function organizationPointer(policy) {
  const pointer = organizationPointers.get(policy);
  if (!pointer) throw new PolicyError("policy_reference", "Validated organization policy is unavailable", policy.provenance.directory);
  return pointer;
}

function inspect(directory) {
  try { return inspectPolicy(directory); }
  catch (cause) {
    if (cause instanceof PolicyError) throw cause;
    const error = new PolicyError("policy_read", `Cannot inspect policy: ${directory}`, directory);
    error.cause = cause;
    throw error;
  }
}

export function loadPolicy(options = {}) {
  const managed = Object.hasOwn(options, "skillDirectory");
  if (managed && (typeof options.skillDirectory !== "string" || !path.isAbsolute(options.skillDirectory))) {
    throw new PolicyError("policy_directory", "skillDirectory must be an absolute directory", options.skillDirectory);
  }
  const bundledDirectory = fileURLToPath(new URL("../skills/memocap", import.meta.url));
  const selected = inspect(managed ? options.skillDirectory : bundledDirectory);
  const bundled = managed ? inspect(bundledDirectory) : selected;
  if (selected.digest !== bundled.digest) {
    throw new PolicyError("policy_digest", `Policy differs from this plugin package: ${selected.directory}`, selected.directory);
  }
  const provenance = Object.freeze({ mode: managed ? "managed" : "bundled", directory: selected.directory,
    mainPath: selected.mainPath, version: packageVersion, digest: selected.digest });
  const policy = Object.freeze({ rules: selected.rules, provenance });
  if (selected.files.some((file) => file.path === "references/memory-organization.md")) {
    organizationPointers.set(policy, Object.freeze({ path: path.join(selected.directory, "references/memory-organization.md"),
      version: provenance.version, digest: provenance.digest }));
  }
  return policy;
}
