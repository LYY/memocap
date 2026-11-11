import { invalidRequest, repositoryID } from "./targets.js";

export function exactPlacement(value) {
  return typeof value === "string" && (value === "universal" || repositoryID.test(value) ||
    /^domain:[^\s*?\0]+$/u.test(value));
}

export function discoveryFor(args, current = { kind: "library" }) {
  if (args.library !== undefined && args.library !== true) invalidRequest();
  if (args.library && args.placements !== undefined) invalidRequest();
  if (args.library) return Object.freeze({ kind: "library" });
  if (args.placements === undefined) return current;
  if (!Array.isArray(args.placements) || args.placements.length === 0 ||
      args.placements.some((placement) => !exactPlacement(placement)) || new Set(args.placements).size !== args.placements.length) invalidRequest();
  return Object.freeze({ kind: "origins", placements: Object.freeze([...args.placements]) });
}

export function discoveryArgs(discovery) {
  switch (discovery.kind) {
    case "library": return ["--library"];
    case "origins": return discovery.placements.flatMap((placement) => ["--placement", placement]);
    default: return invalidRequest();
  }
}

export function discoveryValid(discovery) {
  if (!discovery || typeof discovery !== "object") return false;
  switch (discovery.kind) {
    case "library": return true;
    case "origins": return Array.isArray(discovery.placements) && discovery.placements.length > 0 &&
      discovery.placements.every(exactPlacement) && new Set(discovery.placements).size === discovery.placements.length;
    default: return false;
  }
}
