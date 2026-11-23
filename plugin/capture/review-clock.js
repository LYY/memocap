import { performance } from "node:perf_hooks";

export function reviewClock({ parentID, userID, workflow }) {
  const identity = { parentID, user_id: userID, workflow,
    review_id: JSON.stringify([parentID, userID, workflow]), clock_domain: `node.performance:${performance.timeOrigin}` };
  return (phase, summary = {}) => ({ ...summary, ...identity, phase, monotonic_ms: performance.now() });
}
