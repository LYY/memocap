import { createBinding } from "./binding.js";
import { CaptureStop, data } from "./contract.js";
import { createLifecycle } from "./lifecycle.js";
import { recordReview } from "./review.js";
import { createWorker } from "./worker.js";

export function createCapture(input, runtime, operations) {
  const jobs = new Set();
  const summaries = new Map();
  function track(promise) {
    const job = promise.finally(() => jobs.delete(job));
    jobs.add(job);
    return job;
  }
  const lifecycle = createLifecycle((id) => {
    track(input.client.session.abort({ path: { id }, signal: AbortSignal.timeout(3000) }).then(data).catch(() => {
      if (!runtime.warnings.some((warning) => warning.code === "capture_abort_failed")) runtime.warnings.push({ code: "capture_abort_failed" });
    }));
  });
  const binding = createBinding({ client: input.client, runtime, operations, lifecycle });
  const run = createWorker({ client: input.client, runtime, lifecycle });
  runtime.captureStatus = (id) => {
    const turn = lifecycle.parents.get(id);
    return summaries.get(id)?.value ?? (turn?.reason ? { status: "skipped", reason: turn.reason, user_id: turn.userID,
      model_calls: turn.model_calls, tool_calls: turn.tool_calls, write_attempts: turn.write_attempts } : { status: "not_run" });
  };
  async function review(turn) {
    const timer = setTimeout(() => lifecycle.invalidate(turn, "capture_timeout"), 30000);
    let outcome;
    try { outcome = await run(turn); }
    catch (error) {
      outcome = turn.outcome ?? { status: turn.write_attempts ? "unknown" : error instanceof CaptureStop ? error.status : "failed",
        reason: turn.reason ?? (error instanceof CaptureStop ? error.code : "capture_failed") };
    }
    clearTimeout(timer);
    lifecycle.finish(turn);
    const summary = await recordReview(runtime, turn, outcome);
    if ((summaries.get(turn.parentID)?.generation ?? 0) <= turn.generation) {
      summaries.delete(turn.parentID);
      summaries.set(turn.parentID, { generation: turn.generation, value: summary });
    }
    if (summaries.size > 128) summaries.delete(summaries.keys().next().value);
    delete turn.candidate;
    delete turn.parentState;
    delete turn.outcome;
    delete turn.receipt;
    delete turn.commitPending;
  }
  return { ...binding, observe: lifecycle.observe,
    event({ event }) {
      const turn = lifecycle.event(event);
      if (turn) track(review(turn));
    },
    async dispose() {
      lifecycle.dispose();
      await Promise.allSettled([...jobs]);
      summaries.clear();
      lifecycle.workers.clear();
    } };
}
