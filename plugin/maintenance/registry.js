import { randomUUID } from "node:crypto";
import { immutable, requireMaintenance, sameTask } from "./boundary.js";

export function createBoundedRegistry({ clock = Date.now, ttlMs = 300000, capacity = 64, maxBytes = 1048576 } = {}) {
  requireMaintenance(typeof clock === "function" && Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 300000 &&
    Number.isSafeInteger(capacity) && capacity > 0 && capacity <= 128 &&
    Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 2097152, "invalid_limits");
  const entries = new Map();
  let bytes = 0;
  let disposed = false;
  function drop(handle) {
    const entry = entries.get(handle);
    if (entry) { bytes -= entry.bytes; entries.delete(handle); }
  }
  function prune() {
    const now = clock();
    requireMaintenance(Number.isSafeInteger(now) && now >= 0, "invalid_clock");
    for (const [handle, entry] of entries) if (entry.expiresAt <= now) drop(handle);
    return now;
  }
  function get(handle) {
    requireMaintenance(!disposed, "registry_disposed");
    prune();
    requireMaintenance(typeof handle === "string" && entries.has(handle), "reference_unavailable");
    return entries.get(handle).snapshot;
  }
  function put(snapshot, handle = randomUUID()) {
    requireMaintenance(!disposed, "registry_disposed");
    const now = prune();
    const size = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    requireMaintenance(size <= 65536 && size <= maxBytes, "input_budget");
    const expiresAt = entries.get(handle)?.expiresAt ?? now + ttlMs;
    drop(handle);
    while (entries.size >= capacity || bytes + size > maxBytes) drop(entries.keys().next().value);
    entries.set(handle, { snapshot: immutable(structuredClone(snapshot)), expiresAt, bytes: size });
    bytes += size;
    return handle;
  }
  return Object.freeze({ put, get, drop, prune,
    values() { requireMaintenance(!disposed, "registry_disposed"); prune(); return [...entries.values()].map((entry) => entry.snapshot); },
    cancel(task) { for (const [handle, entry] of entries) if (sameTask(entry.snapshot.task, task)) drop(handle); },
    stats() { prune(); return Object.freeze({ entries: entries.size, bytes, disposed }); },
    dispose() { entries.clear(); bytes = 0; disposed = true; } });
}
