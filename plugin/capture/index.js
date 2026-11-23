import { createBinding } from "./binding.js";
import { CaptureStop, data } from "./contract.js";
import { createLifecycle } from "./lifecycle.js";
import { createObserved } from "./observed.js";
import { recordReview } from "./review.js";
import { reviewClock } from "./review-clock.js";
import { captureExecutionProfile } from './execution-profile.js';
import { captureExecution } from './execution.js';
import { clean } from "./screen.js";
import { createWorker, notifyCapture } from "./worker.js";

export function createCapture(input, runtime, operations) {
  const profile = captureExecutionProfile(input.captureExecutionMs, input.maintenanceExecutionMs);
  const observed = createObserved(input.captureObservation);
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
  const binding = createBinding({ client: input.client, runtime, operations, lifecycle, observed });
  const run = createWorker({ client: input.client, runtime, lifecycle, observed, observation: input.captureObservation?.onDecision });
  runtime.captureStatus = (id) => {
    const turn = lifecycle.parents.get(id);
    return summaries.get(id)?.value ?? (turn?.reason ? { status: "skipped", reason: turn.reason, user_id: turn.userID,
      model_calls: turn.model_calls, tool_calls: turn.tool_calls, write_attempts: turn.write_attempts } : { status: "not_run" });
  };
  async function review(turn) {
    const clock = reviewClock({ parentID: turn.parentID, userID: turn.userID, workflow: 'capture' });
    const started = input.captureObservation?.onLifecycle && clock('review.started');
    if (started) turn.observation = new AbortController();
    const execution = captureExecution(turn, profile, lifecycle, input.captureObservation, clock);
    let outcome;
    try {
      try {
        let allowed;
        try { allowed = await input.captureCoordinator?.beforeReview(turn); }
        finally {
          execution.arm();
          if (started) await notifyCapture(input.captureObservation.onLifecycle, started, { required: true, signal: turn.observation.signal });
        }
        if (allowed === false) throw new CaptureStop('coordinator_cancelled');
        lifecycle.check(turn);
        outcome = await run(turn);
      }
      catch (error) {
        outcome = turn.outcome ?? { status: turn.write_attempts ? "unknown" : error instanceof CaptureStop ? error.status : "failed",
          reason: turn.reason ?? (error instanceof CaptureStop ? error.code : "capture_failed") };
      }
      if (!['saved', 'no_candidate', 'duplicate'].includes(outcome.status) && !['no_candidate', 'duplicate_body'].includes(outcome.reason) &&
          !(outcome.status === 'skipped' && ['body_budget', 'current_evidence_required', 'memory_rejected_mixed_support'].includes(outcome.reason))) {
        observed.breakContinuity(turn.parentID, turn.userID);
      }
      if (outcome.reason === 'memory_rejected_mixed_support') outcome = { ...outcome, reason: 'memory_rejected' };
      execution.terminal();
      lifecycle.finish(turn);
      const summary = await recordReview(runtime, turn, outcome);
      summary.execution_profile = profile;
      summary.timing = execution.timing();
      try { if (started) await notifyCapture(input.captureObservation.onLifecycle, clock('review.finished', summary), { required: true, signal: turn.observation.signal }); }
      catch (error) { summary.observation_warning = error.code; }
      notifyCapture(input.captureObservation?.onReview, { parentID: turn.parentID, user_id: turn.userID, ...summary });
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
    } finally { execution.close(); delete turn.observation; }
  }
  const owns = (id) => binding.owns(id) || Boolean(input.captureCoordinator?.owns(id));
  return { ...binding, owns, read(context) {
      const turn = lifecycle.parents.get(context.sessionID);
      if (!turn || owns(context.sessionID) || turn.phase !== 'observed' || turn.reason || context.abort?.aborted) return;
      const caller = Object.freeze({ rootID: turn.parentID, userID: turn.userID, messageID: context.messageID });
      const signal = context.abort;
      return (receipt, requested) => {
        if (lifecycle.parents.get(caller.rootID) !== turn || !['observed', 'checking'].includes(turn.phase) || turn.reason ||
            turn.controller.signal.aborted || signal?.aborted) return;
        observed.registerRead(receipt, requested, caller);
      };
    }, observe(observation, output) {
      if (owns(observation.sessionID)) return;
      lifecycle.observe(observation, output);
      const turn = lifecycle.parents.get(observation.sessionID);
      if (turn?.userID === output.message.id && !turn.reason) {
        const parts = output.parts.filter((part) => part.type === 'text' && !part.synthetic && !part.ignored && !part.metadata?.memocap);
        if (!clean(parts) || !clean(parts.map((part) => part.text).join(''))) lifecycle.invalidate(turn, 'secret');
      }
      if (turn?.userID === output.message.id && !turn.reason) observed.observe(observation, output);
    },
    event({ event }) {
      const id = event.properties.sessionID ?? event.properties.info?.sessionID ?? event.properties.part?.sessionID ?? event.properties.info?.id;
      const worker = lifecycle.workers.get(id);
      if (!worker && input.captureCoordinator?.owns(id)) return;
      if (!worker) observed.event(event);
      else if (["session.error", "session.deleted"].includes(event.type) && !worker.closed && worker.turn.outcome?.status !== 'saved') {
        observed.clear(worker.turn.parentID, worker.turn.userID);
      }
      const turn = lifecycle.event(event);
      if (!worker && lifecycle.parents.get(id)?.reason) observed.clear(id);
      if (turn) track(review(turn));
    },
    async dispose() {
      observed.dispose();
      lifecycle.dispose();
      await Promise.allSettled([...jobs]);
      summaries.clear();
      lifecycle.workers.clear();
    } };
}
