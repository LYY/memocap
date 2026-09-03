import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PACKAGE_NAME = "@lyy-gh/memocap";
const REPOSITORY = "LYY/memocap";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function rootDirectory(arguments_) {
  if (arguments_.length === 0) {
    return process.cwd();
  }
  if (arguments_.length === 2 && arguments_[0] === "--root") {
    return resolve(arguments_[1]);
  }
  throw new Error("usage: RELEASE_TAG=v<version> node scripts/check-release.mjs [--root directory]");
}

function jsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function repositoryId(repository, source) {
  const url = typeof repository === "string" ? repository : repository?.url;
  if (typeof url !== "string") {
    throw new Error(`${source} repository is missing`);
  }
  const parsed = new URL(url.replace(/^git\+/, ""));
  if (parsed.hostname !== "github.com") {
    throw new Error(`${source} repository must be GitHub ${REPOSITORY}`);
  }
  return parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
}

function cargoMetadata(root) {
  const execution = spawnSync(
    "cargo",
    ["metadata", "--locked", "--no-deps", "--format-version", "1"],
    { cwd: root, encoding: "utf8" },
  );
  if (execution.error) {
    throw new Error(`cargo metadata failed: ${execution.error.message}`);
  }
  if (execution.status !== 0) {
    throw new Error(`cargo metadata failed: ${execution.stderr.trim()}`);
  }
  return JSON.parse(execution.stdout);
}

function lockVersion(lockfile, packageName) {
  const matches = lockfile
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block) => ({
      name: block.match(/^name = "([^"]+)"$/m)?.[1],
      version: block.match(/^version = "([^"]+)"$/m)?.[1],
    }))
    .filter((entry) => entry.name === packageName);
  if (matches.length !== 1 || !matches[0].version) {
    throw new Error(`Cargo.lock must contain one ${packageName} package`);
  }
  return matches[0].version;
}

function checkRelease(root, tag) {
  const packageJson = jsonFile(resolve(root, "package.json"));
  if (packageJson.name !== PACKAGE_NAME) {
    throw new Error(`package name must be ${PACKAGE_NAME}`);
  }
  if (typeof packageJson.version !== "string" || !SEMVER.test(packageJson.version)) {
    throw new Error("package.json version must be valid semver");
  }
  if (!tag.startsWith("v") || !SEMVER.test(tag.slice(1))) {
    throw new Error("RELEASE_TAG must be v-prefixed semver");
  }
  if (tag !== `v${packageJson.version}`) {
    throw new Error(`RELEASE_TAG must equal v${packageJson.version}`);
  }
  if (repositoryId(packageJson.repository, "package.json") !== REPOSITORY) {
    throw new Error(`package.json repository must be ${REPOSITORY}`);
  }

  const metadata = cargoMetadata(root);
  const packages = metadata.packages.filter((value) => value.name === "memocap");
  if (packages.length !== 1) {
    throw new Error("Cargo metadata must contain one memocap package");
  }
  const cargoPackage = packages[0];
  if (cargoPackage.version !== packageJson.version) {
    throw new Error("Cargo metadata version must match package.json version");
  }
  if (repositoryId(cargoPackage.repository, "Cargo metadata") !== REPOSITORY) {
    throw new Error(`Cargo metadata repository must be ${REPOSITORY}`);
  }
  if (lockVersion(readFileSync(resolve(root, "Cargo.lock"), "utf8"), "memocap") !== packageJson.version) {
    throw new Error("Cargo.lock version must match package.json version");
  }
}

function main() {
  const root = rootDirectory(process.argv.slice(2));
  const tag = process.env.RELEASE_TAG?.trim() ?? "";
  checkRelease(root, tag);
  process.stdout.write(`release check passed for ${tag}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`release check failed: ${message}\n`);
  process.exitCode = 1;
}
