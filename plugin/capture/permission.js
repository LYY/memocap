import { matchesPermissionWildcard as matches } from "../permission-wildcard.js";
import { CaptureStop, data } from "./contract.js";

export async function permissionSnapshot(client, turn) {
  const [parent, agents] = await Promise.all([
    client.session.get({ path: { id: turn.parentID }, signal: turn.controller.signal }), client.app.agents({ signal: turn.controller.signal }),
  ]);
  const session = data(parent);
  if (session?.id !== turn.parentID) throw new CaptureStop("permission_unavailable", "denied");
  const { permission: sessionRules = [] } = session;
  const agent = data(agents).find((entry) => entry.name === turn.agent);
  if (!agent || !Array.isArray(agent.permission) || !Array.isArray(sessionRules)) {
    throw new CaptureStop("permission_unavailable", "denied");
  }
  const rules = [...agent.permission, ...sessionRules];
  if (rules.some((rule) => !rule || typeof rule.permission !== "string" || typeof rule.pattern !== "string" ||
      !["allow", "ask", "deny"].includes(rule.action))) throw new CaptureStop("permission_unavailable", "denied");
  const action = rules.findLast((rule) => matches("memocap_remember", rule.permission) &&
    matches(turn.target.repository_id, rule.pattern))?.action ?? "ask";
  if (action === "deny") throw new CaptureStop("permission_deny", "denied");
  return { ...session, permission: sessionRules };
}
