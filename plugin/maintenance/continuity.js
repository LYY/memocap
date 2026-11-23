import { exactObject, fingerprint, immutable, requireMaintenance, sameTask } from "./boundary.js";
import { validateCitations } from "./assessment.js";
import { resolveModelCitations } from "./quote.js";

export function continuationBinding(input, turn, evidence) {
  exactObject(input, ["status", "goal", "object", "environment", "citations"]);
  requireMaintenance(input.status === "same_task" && [input.goal, input.object, input.environment].every((text) =>
    typeof text === "string" && text.trim() && text.length <= 256), "continuity_unknown");
  const citations = resolveModelCitations(input.citations, evidence);
  validateCitations(citations, evidence);
  const cited = citations.map((citation) => evidence.find((entry) => entry.source_id === citation.source_id));
  requireMaintenance(cited.some((entry) => sameTask(entry.task, turn.task)) &&
    cited.some((entry) => !sameTask(entry.task, turn.task)) && cited.every((entry) => entry.outcome === "observed" && entry.completeness === "full"), "continuity_unknown");
  return immutable({ ...input, citations, evidence: evidence.filter((entry) => !sameTask(entry.task, turn.task)).map(fingerprint) });
}

export function createMaintenanceFrames({ clock = Date.now } = {}) {
  const frames = new Map();
  const size = (frame) => Buffer.byteLength(JSON.stringify(frame));
  function prune() {
    for (const [id, frame] of frames) if (clock() - frame.started >= 300000) frames.delete(id);
  }
  return {
    take(parentID) { prune(); const frame = frames.get(parentID); frames.delete(parentID); return frame; },
    drop(parentID) { frames.delete(parentID); },
    save(turn, outcome) {
      prune();
      if (turn.reason || turn.write_attempts || !["no_candidate", "keep", "proposal"].includes(outcome.status) ||
        /denied|deny/.test(outcome.reason ?? "") || !turn.used.length || !turn.origin) return;
      const frame = immutable({ started: turn.prior?.started ?? clock(), turns: (turn.prior?.turns ?? 0) + 1,
        origin: turn.origin, used: [...turn.used], evidence: [...turn.evidence.values()] });
      if (frame.turns >= 4 || clock() - frame.started >= 300000 || frame.evidence.length > 12 || size(frame) > 49152) return;
      frames.set(turn.task.parentID, frame);
      while (frames.size > 64 || [...frames.values()].reduce((sum, entry) => sum + size(entry), 0) > 1048576) frames.delete(frames.keys().next().value);
    },
    clear() { frames.clear(); },
    stats() { prune(); return { entries: frames.size, bytes: [...frames.values()].reduce((sum, entry) => sum + size(entry), 0) }; },
  };
}
