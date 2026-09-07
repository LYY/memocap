"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const LEASE_CONTENTION_WINDOW_MS = 25;

function processStartedAt(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    if (process.platform === "win32") {
      return execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: "utf8" },
      ).trim();
    }
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
  } catch {
    return null;
  }
}

function temporaryPath(destination) {
  return `${destination}.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
}

function ownerIsAlive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    const startedAt = processStartedAt(owner.pid);
    return startedAt ? startedAt === owner.processStart : true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function readLease(leasePath) {
  try {
    const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    if (
      !Number.isSafeInteger(lease?.pid) ||
      lease.pid <= 0 ||
      !Number.isSafeInteger(lease?.createdAt) ||
      typeof lease?.processStart !== "string" ||
      lease.processStart.length === 0 ||
      !["contender", "owner"].includes(lease?.state)
    ) {
      return null;
    }
    return lease;
  } catch {
    return null;
  }
}

function liveLeases(lockPath) {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.lease-`;
  const leases = [];
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return leases;
    }
    throw error;
  }

  for (const name of names) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const leasePath = path.join(directory, name);
    const lease = readLease(leasePath);
    if (!lease || !ownerIsAlive(lease)) {
      fs.rmSync(leasePath, { force: true });
      continue;
    }
    leases.push({ ...lease, path: leasePath });
  }
  return leases;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function compareLeases(left, right) {
  return left.createdAt - right.createdAt || left.path.localeCompare(right.path);
}

async function createCacheLock(lockPath) {
  if (liveLeases(lockPath).length > 0) {
    return null;
  }

  const leasePath = `${lockPath}.lease-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const processStart = processStartedAt(process.pid);
  if (!processStart) {
    throw new Error("unable to determine cache lock process identity");
  }
  const contender = { pid: process.pid, processStart, state: "contender", createdAt: Date.now() };
  fs.writeFileSync(leasePath, JSON.stringify(contender), { flag: "wx", mode: 0o600 });

  try {
    await delay(LEASE_CONTENTION_WINDOW_MS);
    const leases = liveLeases(lockPath);
    if (leases.some((lease) => lease.state === "owner")) {
      return null;
    }
    const winner = leases.sort(compareLeases)[0];
    if (winner?.path !== leasePath) {
      return null;
    }

    const stagedPath = temporaryPath(leasePath);
    try {
      fs.writeFileSync(
        stagedPath,
        JSON.stringify({ ...contender, state: "owner" }),
        { mode: 0o600 },
      );
      fs.renameSync(stagedPath, leasePath);
    } finally {
      fs.rmSync(stagedPath, { force: true });
    }
    return { path: leasePath };
  } finally {
    const lease = readLease(leasePath);
    if (lease?.state !== "owner") {
      fs.rmSync(leasePath, { force: true });
    }
  }
}

module.exports = { createCacheLock };
