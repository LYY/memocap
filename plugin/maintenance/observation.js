import { clean } from "../capture/observed/value.js";
import { fingerprint, immutable } from "./boundary.js";

class MaintenanceObservationError extends Error {
  constructor(cause) {
    super("maintenance_observation_failed", { cause });
    this.name = "MaintenanceObservationError";
    this.code = "maintenance_observation_failed";
  }
}

export async function observeMaintenance(observation, event, signal) {
  let aborted;
  try {
    const pending = Promise.resolve(observation?.(immutable(structuredClone(event))));
    if (!signal) await pending;
    else await new Promise((resolve, reject) => {
      aborted = () => reject(new MaintenanceObservationError(signal.reason));
      pending.then(resolve, reject);
      if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
    });
  }
  catch (cause) { throw new MaintenanceObservationError(cause); }
  finally { if (aborted) signal.removeEventListener('abort', aborted); }
}

export function createDecisionObservation(observation, turn) {
  const emitted = new Set();
  return async (stage, details) => {
    if (!observation || emitted.has(stage) || emitted.size >= 4) return;
    emitted.add(stage);
    const binding = { phase: "maintenance.decision", stage, parentID: turn.task.parentID,
      task: turn.task, user_id: turn.userID, review_id: fingerprint([turn.task, turn.userID]),
      origin_fingerprint: turn.origin, source_fingerprint: turn.sourceHash };
    const value = { ...binding, ...details };
    const screened = Buffer.byteLength(JSON.stringify(value)) > 131072 ? { ...binding, reason: "observation_budget" }
      : !clean(value) ? { ...binding, reason: "unsafe_response" } : value;
    await observeMaintenance(observation, screened, turn.observation?.signal ?? turn.controller?.signal);
  };
}
