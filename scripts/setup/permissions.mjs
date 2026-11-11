import { createScanner, findNodeAtLocation, parse, parseTree, SyntaxKind } from "jsonc-parser";
import { SetupError } from "./arguments.mjs";

const readTools = ["memocap_recall", "memocap_read"];
const grantPath = (tool) => ["permission", tool, "library"];
const atPath = (config, location) => location.reduce((parent, key) => parent?.[key], config);
const matches = (name, pattern) => new RegExp(`^${pattern.split("*").map((part) => part.split("?").map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".")).join(".*")}$`, "s").test(name);

function configuredAction(permission, tool) {
  if (permission === undefined) return null;
  if (typeof permission === "string") return permission;
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) throw new SetupError("invalid_permission_config", "Expected permission action or object");
  let action = null;
  for (const [name, rules] of Object.entries(permission)) {
    if (!matches(tool, name)) continue;
    if (typeof rules === "string") action = rules;
    else if (rules && typeof rules === "object" && !Array.isArray(rules)) {
      for (const [pattern, decision] of Object.entries(rules)) if (matches("library", pattern)) action = decision;
    } else throw new SetupError("invalid_permission_config", `Invalid permission.${name}`);
  }
  if (action !== null && !["allow", "deny", "ask"].includes(action)) throw new SetupError("invalid_permission_config", `Invalid permission action for ${tool}`);
  return action;
}

export function inspectPermissions(config, layers) {
  const conflicts = [];
  const agentLimits = [];
  for (const { filename, config: layer } of layers) for (const tool of readTools) {
    const action = configuredAction(layer.permission, tool);
    const exact = layer.permission?.[tool]?.library;
    const limit = [exact, action].find((decision) => decision === "deny" || decision === "ask");
    if (limit) conflicts.push({ code: "library_permission_conflict", path: filename, permission: grantPath(tool), action: limit });
    for (const [agent, settings] of Object.entries(layer.agent || {})) {
      const decision = configuredAction(settings.permission, tool);
      if (decision === "deny" || decision === "ask") agentLimits.push({ path: filename, agent, permission: grantPath(tool), action: decision });
    }
  }
  return { grants: readTools.map((tool) => ({ path: grantPath(tool), status: atPath(config, grantPath(tool)) === "allow" ? "explicit_allow" : "missing" })), conflicts, agent_limits: agentLimits, runtime_verification: "not_run" };
}

function hasComments(text, location) {
  const node = findNodeAtLocation(parseTree(text), location);
  if (!node) return false;
  const scanner = createScanner(text, false);
  scanner.setPosition(node.offset);
  while (scanner.getPosition() < node.offset + node.length) {
    if ([SyntaxKind.LineCommentTrivia, SyntaxKind.BlockCommentTrivia].includes(scanner.scan())) return true;
  }
  return false;
}

function grantContainers(plan, tool) {
  for (const location of [["permission"], ["permission", tool]]) {
    const current = atPath(plan.config, location);
    if (current !== undefined && typeof current === "object" && current !== null) continue;
    if (current !== undefined && current !== "allow") throw new SetupError("library_permission_conflict", `Preserving permission limit: ${location.join(".")}`);
    const replacement = current === "allow" ? { "*": "allow" } : {};
    plan.owned.containers = plan.owned.containers.filter((container) => JSON.stringify(container.path) !== JSON.stringify(location));
    plan.owned.containers.push({ path: location, previous: current ?? null });
    plan.edits.push({ path: location, value: { ...replacement } });
    if (location.length === 1) plan.config.permission = replacement;
    else plan.config.permission[tool] = replacement;
  }
}

function installLibraryGrant(plan, tool) {
  const location = grantPath(tool);
  const current = atPath(plan.config, location);
  const retained = plan.previous?.leaves?.find((leaf) => JSON.stringify(leaf.path) === JSON.stringify(location));
  if ([current, configuredAction(plan.config.permission, tool)].some((action) => action === "deny" || action === "ask")) {
    plan.grants.push({ path: location, action: "blocked" });
    return;
  }
  plan.grants.push({ path: location, action: current === "allow" ? retained ? "retain_owned" : "preserve_user" : "grant" });
  if (current === "allow") { if (retained) plan.owned.leaves.push(retained); return; }
  grantContainers(plan, tool);
  plan.edits.push({ path: location, value: "allow" });
  plan.config.permission[tool].library = "allow";
  plan.owned.leaves.push({ path: location, value: "allow" });
}

function removeLibraryGrant(plan, tool) {
  const location = grantPath(tool);
  const retained = plan.previous?.leaves?.find((leaf) => JSON.stringify(leaf.path) === JSON.stringify(location));
  const remove = retained && atPath(plan.config, location) === retained.value;
  plan.grants.push({ path: location, action: remove ? "remove_owned" : "preserve_user" });
  if (remove) { plan.edits.push({ path: location, remove: true }); delete plan.config.permission[tool].library; }
}

function restoreContainers(plan, text) {
  for (const container of [...plan.owned.containers].reverse()) {
    const current = atPath(plan.config, container.path);
    const expected = container.previous === "allow" ? { "*": "allow" } : {};
    if (JSON.stringify(current) !== JSON.stringify(expected) || hasComments(text, container.path)) continue;
    plan.edits.push(container.previous === null ? { path: container.path, remove: true } : { path: container.path, value: container.previous });
    const parent = container.path.length === 1 ? plan.config : plan.config.permission;
    if (container.previous === null) delete parent[container.path.at(-1)];
    else parent[container.path.at(-1)] = container.previous;
  }
  plan.owned.containers = [];
}

export function plannedPermissions(scope, previous, operation) {
  const plan = { config: parse(scope.text ?? "{}"), previous, owned: { leaves: [], containers: [...(previous?.containers || [])] }, edits: [], grants: [] };
  for (const tool of readTools) {
    if (operation === "uninstall") removeLibraryGrant(plan, tool);
    else installLibraryGrant(plan, tool);
  }
  if (operation === "uninstall") restoreContainers(plan, scope.text ?? "{}");
  const { grants, edits, owned } = plan;
  return { grants, edits, owned, runtime_verification: "not_run", effects: operation === "uninstall" ? ["remove_unmodified_owned_library_grants"] : ["read_library_memories", "read_full_memory_by_id"] };
}

export function verifyPermissions(config, intent) {
  for (const edit of intent.permissions?.edits || []) {
    if (edit.path.at(-1) !== "library") continue;
    const actual = atPath(config, edit.path);
    if (actual !== (edit.remove ? undefined : edit.value)) throw new SetupError("permission_outcome_unknown", "Permission commit readback differs", { path: edit.path, actual });
  }
}
