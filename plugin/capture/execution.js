import { performance } from 'node:perf_hooks';
import { CaptureStop } from './contract.js';
import { notifyCapture } from './worker.js';

export function captureExecution(turn, profile, lifecycle, observation, clock) {
  Object.defineProperty(turn, 'executionProfile', { value: profile });
  const started = performance.now();
  let armed; let finished;
  const emit = (phase) => {
    if (observation?.onTimer) notifyCapture(observation.onTimer, clock(phase, {
      execution_profile: profile, execution_deadline_ms: turn.executionDeadline ?? null,
    }));
  };
  emit('coordinator.waiting');
  let timer;
  return { arm() {
    armed = performance.now();
    turn.executionDeadline = armed + profile.capture_ms;
    timer = setTimeout(() => {
      if (finished === undefined) { lifecycle.invalidate(turn, 'capture_timeout'); emit('execution.fired'); }
      else { turn.observation?.abort(); emit('terminal.deadline'); }
    }, profile.capture_ms);
    emit('execution.armed');
  }, terminal() { finished = performance.now(); emit('terminal.collecting'); },
  timing() {
    const now = performance.now();
    return Object.freeze({ review_started_ms: started, execution_started_ms: armed, execution_finished_ms: finished,
      coordinator_elapsed_ms: armed - started, execution_elapsed_ms: finished - armed,
      terminal_elapsed_ms: now - finished, review_elapsed_ms: now - started });
  }, close() { clearTimeout(timer); } };
}

export async function captureRequest(turn, lifecycle, action) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(); lifecycle.invalidate(turn, 'provider_timeout');
  }, turn.executionProfile.provider_request_ms);
  try {
    const result = await action(AbortSignal.any([turn.controller.signal, controller.signal]));
    if (controller.signal.aborted && !turn.write_attempts) throw new CaptureStop('provider_timeout', 'failed');
    return result;
  } finally { clearTimeout(timer); }
}
