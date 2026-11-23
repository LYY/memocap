import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { matchesPermissionWildcard as matches } from "../permission-wildcard.js";
import { exactObject, fingerprint, immutable, parseName, parseTask, requireMaintenance } from "./boundary.js";
import { configRules, maintenancePattern, parseRules, parseTarget } from "./permission-target.js";
import { createBoundedRegistry } from "./registry.js";

export { maintenancePattern };
const snapshots = new WeakSet();

export function maintenancePermissionSnapshot(input, requested) {
  exactObject(input, ["config", "parent", "agent", "session"]);
  const target = parseTarget(requested);
  const config = configRules(input.config);
  const layers = [config, parseRules(input.parent), parseRules(input.agent), parseRules(input.session)];
  const patterns = target.participants.map((entry) => maintenancePattern({ ...entry, database: target.database, operation: target.operation }));
  const relevant = layers.map((rules) => rules.filter((rule) => matches("memocap_maintain", rule.permission)));
  const actions = patterns.flatMap((pattern) => relevant.map((rules) => {
    const matching = rules.filter((rule) => matches(pattern, rule.pattern));
    return matching.some((rule) => rule.action === "deny") ? "deny" : matching.at(-1)?.action ?? "ask";
  }));
  const granted = patterns.every((pattern) => config.some((rule) => rule.permission === "memocap_maintain" && rule.action === "allow" &&
    (rule.pattern === pattern || rule.pattern === `${pattern.slice(0, pattern.lastIndexOf(":"))}:*`)));
  const action = actions.includes("deny") ? "deny" : actions.includes("ask") ? "ask" : "allow";
  const snapshot = immutable({ target, patterns, granted, action, fingerprint: fingerprint([target, relevant]) });
  snapshots.add(snapshot);
  return snapshot;
}

export function assertPermissionSnapshot(snapshot, target) {
  requireMaintenance(snapshots.has(snapshot) && isDeepStrictEqual(snapshot.target, target), "permission_unavailable");
  return snapshot;
}

export function createMaintenancePermissionGate(options) {
  requireMaintenance(options?.ttlMs === undefined || options.ttlMs <= 30000, "invalid_limits");
  const requests = createBoundedRegistry({ ttlMs: 30000, ...options });
  const attempted = new WeakSet();
  const bindings = new WeakMap();
  function issue(proposal, snapshot) {
    parseName(proposal.proposal_id); parseTask(proposal.task);
    assertPermissionSnapshot(snapshot, proposal.target);
    requireMaintenance(snapshot.fingerprint === proposal.permission_fingerprint, "permission_changed");
    requireMaintenance(snapshot.action !== "deny", "permission_deny");
    requireMaintenance(snapshot.granted, "maintenance_grant_required");
    requireMaintenance(!requests.values().some((entry) => entry.proposal_id === proposal.proposal_id) && !attempted.has(proposal), "ask_already_requested");
    const request = { permission: "memocap_maintain", patterns: snapshot.patterns, always: snapshot.patterns,
      metadata: { proposal_id: proposal.proposal_id, target: snapshot.target, permission_fingerprint: snapshot.fingerprint } };
    requests.put({ task: proposal.task, proposal_id: proposal.proposal_id, request, state: "pending", authorization: null }, proposal.proposal_id);
    const issued = requests.get(proposal.proposal_id).request;
    attempted.add(proposal); bindings.set(issued, new WeakRef(proposal));
    return issued;
  }
  function respond(request, outcome, current) {
    const entry = requests.get(request?.metadata?.proposal_id);
    requireMaintenance(request === entry.request && entry.state === "pending", "ask_response_invalid");
    requests.put({ ...entry, state: "denied" }, entry.proposal_id);
    requireMaintenance(outcome === "resolved", outcome === "denied" ? "native_permission_denied" : "ask_response_invalid");
    assertPermissionSnapshot(current, entry.request.metadata.target);
    requireMaintenance(current.action !== "deny", "permission_deny");
    requireMaintenance(current.granted && current.fingerprint === entry.request.metadata.permission_fingerprint, "permission_changed");
    const authorization = { authorization_id: randomUUID(), proposal_id: entry.proposal_id, fingerprint: current.fingerprint };
    requests.put({ ...entry, state: "allowed", authorization }, entry.proposal_id);
    const approved = requests.get(entry.proposal_id).authorization;
    bindings.set(approved, bindings.get(request));
    return approved;
  }
  function consume(authorization, proposal, current) {
    const entry = requests.get(proposal.proposal_id);
    requests.drop(proposal.proposal_id);
    requireMaintenance(entry.state === "allowed" && entry.authorization === authorization && bindings.get(authorization).deref() === proposal, "authorization_invalid");
    assertPermissionSnapshot(current, proposal.target);
    requireMaintenance(current.action !== "deny", "permission_deny");
    requireMaintenance(current.granted && current.fingerprint === authorization.fingerprint &&
      current.fingerprint === proposal.permission_fingerprint, "permission_changed");
  }
  return Object.freeze({ issue, respond, consume,
    cancel(task) { requests.cancel(parseTask(task)); }, prune: requests.prune, stats: requests.stats, dispose: requests.dispose });
}
