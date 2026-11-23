import { exactObject, parseDatabase, parseID, parseName, parsePlacement, recordKey, requireMaintenance } from "./boundary.js";

export function parseOperation(operation) {
  requireMaintenance(["update", "merge", "delete"].includes(operation), "invalid_request");
  return operation;
}

export function parseTarget(input) {
  exactObject(input, ["database", "operation", "participants"]);
  parseDatabase(input.database); parseOperation(input.operation);
  requireMaintenance(Array.isArray(input.participants) && input.participants.length > 0 && input.participants.length <= 3, "invalid_request");
  const participants = input.participants.map((entry) => {
    exactObject(entry, ["id", "placement"]);
    return { id: parseID(entry.id), placement: parsePlacement(entry.placement) };
  });
  requireMaintenance(new Set(participants.map(recordKey)).size === participants.length &&
    new Set(participants.map((entry) => entry.placement)).size === 1 &&
    (input.operation === "merge" ? participants.length >= 2 : participants.length === 1), "invalid_request");
  return { database: input.database, operation: input.operation, participants };
}

export function maintenancePattern(input) {
  exactObject(input, ["database", "placement", "operation", "id"]);
  const database = parseDatabase(input.database);
  const placement = parsePlacement(input.placement);
  parseOperation(input.operation); parseID(input.id);
  return `v1/db:${Buffer.from(database, "utf8").toString("base64url")}/placement:${Buffer.from(placement, "utf8").toString("base64url")}/op:${input.operation}/id:${input.id}`;
}

export function parseRules(input) {
  requireMaintenance(Array.isArray(input) && input.length <= 256, "permission_unavailable");
  return input.map((rule) => {
    exactObject(rule, ["permission", "pattern", "action"]);
    parseName(rule.permission); parseName(rule.pattern);
    requireMaintenance(["allow", "ask", "deny"].includes(rule.action), "permission_unavailable");
    return { permission: rule.permission, pattern: rule.pattern, action: rule.action };
  });
}

export function configRules(config) {
  requireMaintenance(config && typeof config === "object" && !Array.isArray(config), "permission_unavailable");
  const permission = config.permission ?? {};
  if (typeof permission === "string") return parseRules([{ permission: "*", pattern: "*", action: permission }]);
  requireMaintenance(permission && typeof permission === "object" && !Array.isArray(permission) && Object.keys(permission).length <= 256, "permission_unavailable");
  const rules = Object.entries(permission).flatMap(([key, patterns]) => {
    if (typeof patterns === "string") return [{ permission: key, pattern: "*", action: patterns }];
    requireMaintenance(patterns && typeof patterns === "object" && !Array.isArray(patterns), "permission_unavailable");
    return Object.entries(patterns).map(([pattern, action]) => ({ permission: key, pattern, action }));
  });
  return parseRules(rules);
}
