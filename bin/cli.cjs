#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const VERSION = require("../package.json").version;

const ASSETS = {
  "linux-x64": "memocap-x86_64-unknown-linux-gnu",
  "darwin-arm64": "memocap-aarch64-apple-darwin",
  "win32-x64": "memocap-x86_64-pc-windows-msvc.exe",
};

const CACHE_LOCK_RETRY_MS = 100;
const CACHE_LOCK_TIMEOUT_MS = 60_000;

function resolveReleaseAsset(platform, arch) {
  const key = `${platform}-${arch}`;
  const name = ASSETS[key];
  if (!name) {
    throw new Error(
      `unsupported platform ${platform}/${arch}. Supported: linux/x64, darwin/arm64, win32/x64.`,
    );
  }
  return {
    name,
    url: `https://github.com/LYY/memocap/releases/download/v${VERSION}/${name}`,
    checksumUrl: `https://github.com/LYY/memocap/releases/download/v${VERSION}/${name}.sha256`,
  };
}

function cacheDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "memocap", VERSION);
  }
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "memocap", VERSION);
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "memocap", VERSION);
}

function temporaryPath(destination) {
  return `${destination}.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function download(url, dest) {
  const tmp = `${temporaryPath(dest)}.partial`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp);
    const fail = (err) => {
      file.close(() => {
        fs.unlink(tmp, () => reject(err));
      });
    };
    const get = (current, hops) => {
      if (hops > 5) {
        fail(new Error("too many redirects"));
        return;
      }
      https
        .get(current, { headers: { "User-Agent": "memocap" } }, (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            get(res.headers.location, hops + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            fail(new Error(`download failed: HTTP ${res.statusCode} ${current}`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => {
            file.close((err) => {
              if (err) {
                fail(err);
                return;
              }
              resolve();
            });
          });
        })
        .on("error", fail);
    };
    file.on("error", fail);
    get(url, 0);
  }).then(() => {
    fs.renameSync(tmp, dest);
  });
}

function expectedChecksum(manifest, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = manifest.trim().match(new RegExp(`^([a-f0-9]{64})  ${escapedName}$`, "i"));
  if (!match) throw new Error(`invalid checksum manifest for ${name}`);
  return match[1].toLowerCase();
}

function verifyCachedBinary(binary, checksum, name) {
  try {
    const expected = Buffer.from(expectedChecksum(fs.readFileSync(checksum, "utf8"), name), "hex");
    const actual = crypto.createHash("sha256").update(fs.readFileSync(binary)).digest();
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function acquireCacheLock(release, binary) {
  const checksum = `${binary}.sha256`;
  const lockPath = `${binary}.lock`;
  const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS;
  for (;;) {
    if (verifyCachedBinary(binary, checksum, release.name)) {
      return null;
    }
    try {
      return { file: fs.openSync(lockPath, "wx"), path: lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for cache download of ${release.name}`);
      }
      await delay(CACHE_LOCK_RETRY_MS);
    }
  }
}

async function downloadVerifiedCache(release, binary, checksum) {
  const stagedChecksum = temporaryPath(checksum);
  const stagedBinary = temporaryPath(binary);
  try {
    await download(release.checksumUrl, stagedChecksum);
    await download(release.url, stagedBinary);
    if (!verifyCachedBinary(stagedBinary, stagedChecksum, release.name)) {
      throw new Error(`checksum mismatch for ${release.name}`);
    }
    fs.chmodSync(stagedBinary, 0o755);
    fs.rmSync(binary, { force: true });
    fs.rmSync(checksum, { force: true });
    fs.renameSync(stagedChecksum, checksum);
    fs.renameSync(stagedBinary, binary);
    return binary;
  } finally {
    fs.rmSync(stagedChecksum, { force: true });
    fs.rmSync(stagedBinary, { force: true });
  }
}

function releaseCacheLock(lock) {
  try {
    fs.closeSync(lock.file);
  } finally {
    fs.rmSync(lock.path, { force: true });
  }
}

async function replaceCachedBinary(release, binary) {
  const checksum = `${binary}.sha256`;
  const lock = await acquireCacheLock(release, binary);
  if (!lock) {
    fs.chmodSync(binary, 0o755);
    return binary;
  }
  try {
    if (verifyCachedBinary(binary, checksum, release.name)) {
      fs.chmodSync(binary, 0o755);
      return binary;
    }
    return await downloadVerifiedCache(release, binary, checksum);
  } finally {
    releaseCacheLock(lock);
  }
}

async function resolveBinary() {
  if (process.env.MEMOCAP_BINARY) {
    return process.env.MEMOCAP_BINARY;
  }
  const release = resolveReleaseAsset(process.platform, process.arch);
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, release.name);
  const checksum = `${dest}.sha256`;
  if (verifyCachedBinary(dest, checksum, release.name)) {
    fs.chmodSync(dest, 0o755);
    return dest;
  }
  return replaceCachedBinary(release, dest);
}

async function main() {
  try {
    const bin = await resolveBinary();
    const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
    if (result.error) {
      console.error(`memocap: ${result.error.message}`);
      process.exit(1);
    }
    process.exit(result.status === null ? 1 : result.status);
  } catch (err) {
    console.error(`memocap: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { resolveReleaseAsset, verifyCachedBinary };

if (require.main === module) {
  main();
}
