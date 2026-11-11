"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { digest, write } = require("../packaged-runtime.cjs");

const registry = "https://registry.npmjs.org";
const integrity = "sha512-EZRVLxVppOVfU59+RHmiaPNPZri4VsIE/iKGzuIH9wjRw0acrMib5CDaZ4oYVUcNwvm3US27nDiSPk2E2xU6Kg==";

function nativeCache(fixture, name) {
  const base = process.platform === "darwin" ? path.join(fixture.home, "Library/Caches") :
    process.platform === "win32" ? fixture.env.LOCALAPPDATA : fixture.env.XDG_CACHE_HOME;
  return path.join(base, "memocap/0.5.0", name);
}

async function preparePrior(fixture, evidence) {
  const { command, root, installedRoot } = fixture;
  const dist = JSON.parse((await command("npm", ["view", "@lyy-gh/memocap@0.5.0", "dist", "--json", "--registry", registry])).stdout);
  evidence.prior_package = { registry, dist, provenance_verification: "registry_metadata_retained_not_independently_verified" };
  assert.equal(dist.integrity, integrity, "published 0.5.0 must match the pinned tarball");
  assert.ok(dist.attestations?.provenance?.predicateType, "published provenance reference missing");
  const packed = JSON.parse((await command("npm", ["pack", "@lyy-gh/memocap@0.5.0", "--registry", registry,
    "--ignore-scripts", "--json", "--pack-destination", root], { cwd: root })).stdout)[0];
  const tarball = path.join(root, packed.filename);
  const bytes = fs.readFileSync(tarball);
  assert.equal(`sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`, integrity);
  assert.equal(crypto.createHash("sha1").update(bytes).digest("hex"), dist.shasum);
  assert.equal(packed.version, "0.5.0");
  Object.assign(evidence.prior_package, { packed, sha256: digest(bytes), bytes: bytes.length });
  await command("npm", ["install", "--global", "--prefix", fixture.prefix, "--ignore-scripts", tarball]);
  const metadata = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json")));
  assert.equal(metadata.name, "@lyy-gh/memocap");
  assert.equal(metadata.version, "0.5.0");
  evidence.prior_package.scripts = metadata.scripts || {};
  evidence.prior_package.package_scripts_executed = false;
  const launcher = path.join(installedRoot, "bin/cli.cjs");
  const { resolveReleaseAsset, verifyCachedBinary } = require(launcher);
  const asset = resolveReleaseAsset(process.platform, process.arch);
  const cached = nativeCache(fixture, asset.name);
  if (process.env.MEMOCAP_TEST_PRIOR_NATIVE) {
    const source = path.resolve(process.env.MEMOCAP_TEST_PRIOR_NATIVE);
    const version = (await command(source, ["--version"])).stdout.trim();
    assert.equal(version, "memocap 0.5.0");
    const sha256 = digest(fs.readFileSync(source));
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.copyFileSync(source, cached);
    fs.chmodSync(cached, 0o755);
    write(`${cached}.sha256`, `${sha256}  ${asset.name}\n`);
    evidence.prior_native = { origin: "explicit_locally_built_prior_not_published_asset", source, version, sha256 };
  } else {
    evidence.prior_native = { origin: "official_github_v0.5.0_checksum_verified_by_published_launcher",
      asset_url: asset.url, checksum_url: asset.checksumUrl };
  }
  const version = (await command("memocap", ["--version"])).stdout.trim();
  assert.equal(version, "memocap 0.5.0");
  assert.ok(verifyCachedBinary(cached, `${cached}.sha256`, asset.name));
  Object.assign(evidence.prior_native, { version, sha256: digest(fs.readFileSync(cached)),
    checksum: fs.readFileSync(`${cached}.sha256`, "utf8"), launcher_sha256: digest(fs.readFileSync(launcher)) });
  evidence.prior_help = {};
  for (const args of [["--help"], ["remember", "--help"], ["scope", "copy", "--help"],
    ["scope", "domain", "create", "--help"], ["scope", "domain", "attach", "--help"]]) {
    evidence.prior_help[args.join(" ")] = (await command("memocap", args)).stdout;
  }
  evidence.prior_help.setup = (await command("memocap-setup", ["--help"])).stdout;
}

module.exports = { preparePrior };
