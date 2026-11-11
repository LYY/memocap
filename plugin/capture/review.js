import { randomUUID } from "node:crypto";

export async function recordReview(runtime, turn, outcome) {
  const operation_id = randomUUID();
  const metadata = { status: outcome.status, reason: outcome.reason, memory_ids: outcome.memory_ids ?? [],
    model_calls: turn.model_calls, tool_calls: turn.tool_calls, write_attempts: turn.write_attempts };
  const summary = { ...metadata, operation_id, user_id: turn.userID, child_ids: [...turn.children],
    ...(outcome.receipt?.operation_id ? { write_operation_id: outcome.receipt.operation_id } : {}) };
  const payload = { operation_id, related_operation_id: outcome.receipt?.operation_id ?? null,
    started_at: new Date().toISOString(), elapsed_ms: 0,
    context: { repository_ids: turn.target ? [turn.target.repository_id] : [], session_id: turn.parentID,
      message_id: turn.userID, actor: "plugin", backend: outcome.receipt?.backend ?? "local", origin: "plugin" },
    receipt: { truncated: false, result_limit: 1, max_chars: 1200, error_code: null },
    detail: { phase: "capture_review", metadata } };
  try {
    const state = await runtime.context(turn.parentID);
    const result = await runtime.request(state, ["activity", "record", "--payload", JSON.stringify(payload)],
      { signal: AbortSignal.timeout(3000), caller: { sessionID: turn.parentID, messageID: turn.userID } });
    if (result.activity_status === "failed") summary.activity_warning = "activity_failed";
  } catch { summary.activity_warning = "activity_failed"; }
  return summary;
}
