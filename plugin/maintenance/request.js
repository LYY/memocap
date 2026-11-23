import { participantIDs } from "./assessment.js";
import { requireMaintenance } from "./boundary.js";

export function nativeRequest(proposal) {
  const { decision, used } = proposal;
  const original = used.find((entry) => entry.use_id === decision.target).snapshot;
  let group;
  switch (decision.action) {
    case "update": group = { action: "refine", expected: original, content: decision.content }; break;
    case "merge": group = { action: "merge", survivor: original, content: decision.content,
      sources: decision.sources.map((id) => used.find((entry) => entry.use_id === id).snapshot) }; break;
    case "delete": group = { action: "delete", expected: original }; break;
    default: requireMaintenance(false, "no_mutation");
  }
  return { mode: "all", group, dependencies: used.filter((entry) => !participantIDs(decision).includes(entry.use_id)).map((entry) => entry.snapshot) };
}
