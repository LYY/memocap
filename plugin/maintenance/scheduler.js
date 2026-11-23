import { reviewClock } from "../capture/review-clock.js";
import { observeMaintenance } from "./observation.js";
import { captureExecutionProfile } from '../capture/execution-profile.js';

export function createMaintenanceScheduler({ client, runtime, tasks, frames, reviewer, summaries, jobs, observation, captureExecutionMs, maintenanceExecutionMs }) {
  const profile = captureExecutionProfile(captureExecutionMs, maintenanceExecutionMs);
  function track(promise) {
    const job = promise.finally(() => jobs.delete(job));
    jobs.add(job);
    return job;
  }
  async function run(turn) {
    const clock = observation && reviewClock({ parentID: turn.task.parentID, userID: turn.userID, workflow: 'maintenance' });
    if (observation) turn.observation = new AbortController();
    const timer = setTimeout(() => tasks.invalidate(turn, "maintenance_timeout"), profile.maintenance_ms);
    let outcome;
    try {
      try {
        if (clock) await observeMaintenance(observation, clock('review.started', { execution_profile: profile }), turn.observation.signal);
        outcome = await reviewer.review(turn);
      }
      catch (error) { outcome = turn.outcome ?? { status: turn.write_attempts ? "unknown" : "blocked", reason: turn.reason ?? error.code ?? "maintenance_failed" }; }
      if (turn.commitPending) await turn.commitPending;
      const value = { ...(turn.outcome ?? outcome), user_id: turn.userID, model_calls: turn.model_calls,
        tool_calls: turn.tool_calls, write_attempts: turn.write_attempts, child_sessions: turn.children.length,
        execution_profile: profile, budgets: { children: 2, generations: 3, atomic_groups: 1, timeout_ms: profile.maintenance_ms },
        combined_with_capture: { children: 4, generations: 6, atomic_groups: 2, timeout_ms: profile.maintenance_ms + profile.capture_ms } };
      if (!summaries.has(turn.task.parentID) || summaries.get(turn.task.parentID).epoch <= turn.task.epoch) {
        summaries.set(turn.task.parentID, { epoch: turn.task.epoch, value });
      }
      if (summaries.size > 64) summaries.delete(summaries.keys().next().value);
      turn.phase = "finished";
      frames.save(turn, value);
      for (const id of turn.children) {
        const worker = tasks.workers.get(id);
        if (worker) worker.closed = true;
        await client.session.abort({ path: { id }, signal: AbortSignal.timeout(3000) }).catch(() => {
          if (!runtime.warnings.some((warning) => warning.code === "maintenance_abort_failed")) runtime.warnings.push({ code: "maintenance_abort_failed" });
        });
        const removed = await client.session.delete({ path: { id }, signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (removed && !removed.error && removed.data === true) tasks.workers.delete(id);
      }
      turn.evidence.clear();
      turn.used.length = 0;
      delete turn.prior;
      delete turn.permissionSnapshots;
      delete turn.native;
      delete turn.tools;
      delete turn.proposal;
      delete turn.commitPending;
      try { if (clock) await observeMaintenance(observation, clock('review.finished', value), turn.observation.signal); }
      catch (error) { value.observation_warning = error.code; }
      try { await observeMaintenance(observation, { phase: "maintenance.review", parentID: turn.task.parentID, ...value }, turn.observation?.signal); }
      catch (error) { value.observation_warning = error.code; }
      if (turn.reason) return false;
      switch (value.status) {
        case 'no_candidate': return ['no_adopted_records', 'no_revision'].includes(value.reason);
        case 'keep': return value.reason === 'no_revision';
        case 'unknown': return value.write_attempts === 0 && ['no_revision', 'evidence_unavailable', 'input_budget',
          'unsupported', 'unknown', 'continuity_unknown'].includes(value.reason);
        case 'committed': return value.reason === 'committed';
        default: return false;
      }
    } finally { clearTimeout(timer); delete turn.observation; }
  }
  function schedule(turn) {
    if (!turn.reviewPending) {
      turn.phase = "reviewing";
      turn.reviewPending = track(run(turn));
    }
    return turn.reviewPending;
  }
  function event(envelope) {
    tasks.event(envelope);
    const event = envelope.event;
    const id = event.properties.sessionID;
    const idle = event.type === "session.idle" || event.type === "session.status" && event.properties.status?.type === "idle";
    const turn = tasks.parents.get(id);
    if (idle && turn && !turn.reason && tasks.complete(turn)) schedule(turn);
  }
  return { event, async beforeReview(captureTurn) {
    const turn = tasks.parents.get(captureTurn.parentID);
    if (!turn) return true;
    if (turn.userID !== captureTurn.userID || turn.reason || !tasks.complete(turn)) return false;
    return schedule(turn);
  } };
}
