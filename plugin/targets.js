export const repositoryID = /^repository:[a-f0-9]{64}$/;

export function invalidRequest() {
  throw Object.assign(new Error("Invalid memory request"), { code: "invalid_request" });
}

const nullableText = (text) => text === null || typeof text === "string";
const nameSources = ["remote", "git_common_directory", "directory"];
const origins = ["local", "client_reported"];

function descriptorValid(descriptor) {
  return descriptor === null || (descriptor && typeof descriptor.display_name === "string" &&
    nameSources.includes(descriptor.name_source) && origins.includes(descriptor.origin) &&
    nullableText(descriptor.normalized_remote));
}

export function freezeTargets(receipt) {
  if (receipt.operation !== "scope_resolve" || receipt.status !== "ok" ||
      receipt.targets.length < 1 || receipt.targets.length > 8 ||
      new Set(receipt.targets.map((target) => JSON.stringify([
        target.canonical_path, target.canonical_path === null ? target.repository_id : null,
      ]))).size !== receipt.targets.length ||
      receipt.targets.some((target) => !repositoryID.test(target.repository_id) ||
        !nullableText(target.canonical_path) || typeof target.identity_source !== "string" ||
        !Array.isArray(target.placements) || target.placements.length !== 1 || target.placements[0] !== target.repository_id ||
        !descriptorValid(target.descriptor) || !nullableText(target.observed_at))) {
    throw Object.assign(new Error("Invalid resolved targets"), { code: "invalid_receipt" });
  }
  return Object.freeze(receipt.targets.map((target) => Object.freeze({ ...target,
    placements: Object.freeze([...target.placements]),
    descriptor: target.descriptor === null ? null : Object.freeze({ ...target.descriptor }) })));
}

export function contextValid(context) {
  return context !== null && typeof context === "object" && !Array.isArray(context) &&
    Object.entries(context).every(([id, entry]) => repositoryID.test(id) && entry &&
      descriptorValid(entry.identity) && (entry.identity === null || typeof entry.identity.recorded_at === "string") &&
      Array.isArray(entry.locations) && entry.locations.every((location) => location &&
        typeof location.canonical_path === "string" && typeof location.observed_at === "string" && typeof location.source === "string"));
}
