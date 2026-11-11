import { createHash } from "node:crypto";
import { matchesPermissionWildcard as matches } from "./permission-wildcard.js";

export class ReadPermissionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.status = "blocked";
  }
}

function rulesValid(rules) {
  return Array.isArray(rules) && rules.every((rule) => rule && typeof rule.permission === "string" &&
    typeof rule.pattern === "string" && ["allow", "ask", "deny"].includes(rule.action));
}

function evaluate(permission, rules) {
  return rules.findLast((rule) => matches(permission, rule.permission) && matches("library", rule.pattern))?.action ?? "ask";
}

export function createReadPermission(input) {
  let config;
  const denials = new Map();

  async function snapshot(context) {
    try {
      const [session, agents] = await Promise.all([
        input.client.session.get({ path: { id: context.sessionID } }), input.client.app.agents(),
      ]);
      const name = context.agent ?? session.data?.agent;
      const agent = Array.isArray(agents.data) ? agents.data.find((entry) => entry.name === name) : undefined;
      const sessionRules = session.data?.permission === undefined ? [] : session.data.permission;
      if (session.error || agents.error || !session.data || !agent || !rulesValid(agent.permission) || !rulesValid(sessionRules)) {
        throw new ReadPermissionError("permission_unavailable");
      }
      const rules = [...agent.permission, ...sessionRules];
      const persistent = config?.permission?.memocap_recall?.library === "allow";
      const relevant = rules.filter((rule) => matches("library", rule.pattern) &&
        ["memocap_recall", "memocap_read"].some((permission) => matches(permission, rule.permission)));
      const key = createHash("sha256").update(JSON.stringify([persistent, relevant])).digest("hex");
      return { key, persistent, recall: evaluate("memocap_recall", rules), read: evaluate("memocap_read", rules) };
    } catch (error) {
      if (error instanceof ReadPermissionError) throw error;
      throw new ReadPermissionError("permission_unavailable");
    }
  }

  function assertAllowed(context, observed, exact = false) {
    const action = exact && observed.read !== "allow" ? observed.read : observed.recall;
    if (action !== "allow") throw new ReadPermissionError(`permission_${action}`);
    const denied = denials.get(context.sessionID);
    if (denied === observed.key) throw new ReadPermissionError("native_permission_denied");
    if (denied) denials.delete(context.sessionID);
  }

  async function check(context, exact = false) {
    const observed = await snapshot(context);
    if (!observed.persistent) throw new ReadPermissionError("library_grant_required");
    assertAllowed(context, observed, exact);
    return observed.key;
  }

  async function authorize(context, metadata, exact = false) {
    if (typeof context.ask !== "function") return check(context, exact);
    const observed = await snapshot(context);
    if (observed.recall === "deny" || (exact && observed.read === "deny")) {
      denials.set(context.sessionID, observed.key);
      throw new ReadPermissionError("permission_deny");
    }
    try {
      await context.ask({ permission: "memocap_recall", patterns: ["library"], always: ["library"], metadata });
      if (exact) await context.ask({ permission: "memocap_read", patterns: ["library"], always: ["library"], metadata });
    } catch {
      denials.set(context.sessionID, observed.key);
      throw new ReadPermissionError("native_permission_denied");
    }
    const current = await snapshot(context);
    if (current.recall === "deny" || (exact && current.read === "deny")) {
      denials.set(context.sessionID, current.key);
      throw new ReadPermissionError("permission_deny");
    }
    denials.delete(context.sessionID);
    return current.key;
  }

  return { check, authorize, config(value) { config = value; },
    forget(sessionID) { denials.delete(sessionID); }, dispose() { denials.clear(); } };
}
