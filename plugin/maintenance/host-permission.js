import { fingerprint, requireMaintenance } from "./boundary.js";
import { maintenancePermissionSnapshot } from "./permission.js";

export function nativeData(response) {
  requireMaintenance(response && !response.error && response.data !== undefined, "host_response_failed");
  return response.data;
}

export async function hostPermission(client, turn, target, sessionID = turn.task.parentID) {
  const signal = turn.controller.signal;
  const [config, parent, agents, session] = await Promise.all([
    client.config.get({ signal }), client.session.get({ path: { id: turn.task.parentID }, signal }),
    client.app.agents({ signal }), client.session.get({ path: { id: sessionID }, signal }),
  ]);
  const origin = nativeData(parent);
  const agent = nativeData(agents).find((entry) => entry.name === turn.agent);
  requireMaintenance(!origin.parentID && agent, "parent_required");
  const layers = { config: { permission: nativeData(config).permission }, parent: origin.permission,
    agent: agent.permission, session: nativeData(session).permission };
  turn.permissionSnapshots ??= new Map();
  turn.permissionSnapshots.set(turn.task.parentID, fingerprint(layers.parent));
  turn.permissionSnapshots.set(sessionID, fingerprint(layers.session));
  return { permission: target ? maintenancePermissionSnapshot(layers, target) : null, layers, origin };
}
