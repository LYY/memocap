import { randomUUID } from "node:crypto";
import { budgetChars, failure } from "./protocol.js";

function eventBase(state, receipt, metadata) {
  return { operation_id: metadata.activity_operation_id, related_operation_id: receipt?.operation_id ?? null,
    started_at: new Date().toISOString(), elapsed_ms: 0,
    context: { repository_ids: receipt?.targets.map((target) => target.repository_id) ?? [],
      session_id: state.sessionID, message_id: state.messageID, actor: "plugin",
      backend: receipt?.backend ?? "local", origin: "plugin" },
    receipt: { truncated: receipt?.truncated ?? false, result_limit: 3, max_chars: budgetChars,
      error_code: metadata.error?.code ?? null } };
}

function eventDetails(receipt, metadata) {
  return [
    { phase: "recall", metadata: { status: metadata.status, searched_placements: receipt?.searched_placements ?? [],
      query_terms: metadata.query_terms, matched_ids: receipt?.matched_ids ?? [], returned_ids: metadata.returned_ids } },
    { phase: "injection_prepared", metadata: { status: receipt ? "ok" : "failed",
      injected_ids: metadata.injected_ids, cache_hit: metadata.cache_hit } },
  ];
}

export async function recordActivity({ state, receipt, metadata, request, expiresAt }) {
  if (Date.now() >= expiresAt) return { code: "activity_not_recorded" };
  metadata.activity_operation_id = randomUUID();
  const base = eventBase(state, receipt, metadata);
  try {
    for (const detail of eventDetails(receipt, metadata)) {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) return { code: "activity_not_recorded" };
      const recorded = await request(state, ["activity", "record", "--payload", JSON.stringify({ ...base, detail })],
        { deadlineMs: remaining });
      if (recorded.activity_status === "failed") return { code: "activity_failed" };
    }
  } catch (error) {
    return { code: "activity_failed", error: failure(error).error };
  }
}
