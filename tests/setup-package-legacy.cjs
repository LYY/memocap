"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { digest, write, snapshot } = require("./packaged-runtime.cjs");

async function legacyMissing(fixture, prepared, evidence) {
  const version = "0.2.1";
  const asset = { "darwin-arm64": "memocap-aarch64-apple-darwin", "linux-x64": "memocap-x86_64-unknown-linux-gnu", "win32-x64": "memocap-x86_64-pc-windows-msvc.exe" }[`${process.platform}-${process.arch}`];
  const base = `https://github.com/LYY/memocap/releases/download/v${version}/${asset}`;
  const download = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200, url);
    return Buffer.from(await response.arrayBuffer());
  };
  const [bytes, checksum] = await Promise.all([download(base), download(`${base}.sha256`)]);
  const sha256 = digest(bytes);
  assert.equal(checksum.toString().trim(), `${sha256}  ${asset}`);
  const cacheBase = process.platform === "darwin" ? path.join(fixture.home, "Library/Caches") :
    process.platform === "win32" ? fixture.env.LOCALAPPDATA : fixture.env.XDG_CACHE_HOME;
  const cached = path.join(cacheBase, "memocap", version, asset);
  write(cached, bytes);
  fs.chmodSync(cached, 0o755);
  write(`${cached}.sha256`, checksum);
  assert.equal((await fixture.command(cached, ["--version"])).stdout.trim(), `memocap ${version}`);
  const prefix = path.join(fixture.root, "old producer");
  const publicMetadataResponse = await fetch(`https://registry.npmjs.org/@lyy-gh%2Fmemocap/${version}`);
  assert.equal(publicMetadataResponse.status, 200);
  const publicMetadata = await publicMetadataResponse.json();
  const oldTarball = await download(publicMetadata.dist.tarball);
  assert.equal(`sha512-${crypto.createHash("sha512").update(oldTarball).digest("base64")}`, publicMetadata.dist.integrity);
  const oldTarballPath = path.join(fixture.root, "published-0.2.1.tgz");
  write(oldTarballPath, oldTarball);
  await fixture.command("npm", ["install", "--prefix", prefix, "--ignore-scripts", oldTarballPath,
    "--registry", "https://registry.npmjs.org"]);
  const oldRoot = path.join(prefix, "node_modules/@lyy-gh/memocap");
  assert.equal(JSON.parse(fs.readFileSync(path.join(oldRoot, "package.json"))).version, version);
  const previousManifest = path.join(fixture.env.XDG_STATE_HOME, "memocap/setup.json");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(previousManifest)).installs), []);
  fs.rmSync(previousManifest);
  await fixture.command("npm", ["uninstall", "--global", "@lyy-gh/memocap"]);
  const oldEnv = { ...fixture.env, NODE_OPTIONS: "", npm_config_registry: "https://registry.npmjs.org",
    PATH: [path.dirname(fixture.host), ...fixture.env.PATH.split(path.delimiter)
      .filter((directory) => directory !== path.join(fixture.root, "guard-bin"))].join(path.delimiter) };
  const produced = await fixture.command(process.execPath, [path.join(oldRoot, "scripts/setup.mjs"),
    "install", "--to", version, "--global", "--yes", "--json"], { env: oldEnv, timeout: 240000 });
  const report = JSON.parse(produced.stdout);
  assert.equal(report.exit_code, 0, JSON.stringify(report));
  const manifest = JSON.parse(fs.readFileSync(report.manifest_path));
  assert.equal(manifest.format_version, 1, "format1 must be produced by the actual old package");
  const canonical = path.join(fixture.home, ".agents/skills/memocap");
  assert.ok(fs.existsSync(path.join(canonical, "SKILL.md")));
  const skillLock = path.join(fixture.env.XDG_STATE_HOME, "skills/.skill-lock.json");
  assert.ok(fs.existsSync(skillLock));
  fs.rmSync(canonical, { recursive: true });
  const oldLocks = snapshot([skillLock]);
  const migratedResult = await fixture.command(process.execPath, [path.join(prepared.runnerRoot, "scripts/setup.mjs"),
    "update", "--to", fixture.version, "--global", "--yes", "--json"]);
  const migrated = JSON.parse(migratedResult.stdout);
  assert.equal(migrated.exit_code, 0, JSON.stringify(migrated));
  assert.equal(JSON.parse(fs.readFileSync(report.manifest_path)).format_version, 2);
  assert.equal(fs.existsSync(canonical), false);
  assert.deepEqual(snapshot([skillLock]), oldLocks);
  assert.equal(fs.existsSync(fixture.guardLog), false);
  evidence.legacy_producer = { version, npm_integrity: publicMetadata.dist.integrity, native_sha256: sha256,
    native_version: `memocap ${version}`, format1_produced_by_actual_package: true,
    canonical_removed_in_sandbox: true, migration_format2: true, old_lock_bytes_unchanged: true,
    old_default_skills_cli: "actual published 0.2.1 behavior; excluded from 0.3.0 zero-call claim" };
  evidence.assertions.push("actual registry-verified 0.2.1 producer and native migrate missing canonical without restoring old locks");
  return migrated;
}

module.exports = { legacyMissing };
