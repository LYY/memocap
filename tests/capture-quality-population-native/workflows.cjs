const { requireStage, identifier } = require('./value.cjs');
const { executionProfile } = require('./execution-profile.cjs');
function createWorkflows(clock = Date.now, captureExecutionMs, maintenanceExecutionMs) {
  const profile = executionProfile(undefined, captureExecutionMs, maintenanceExecutionMs);
  const reviews = new Map();
  const stages = new Map([['memocap capture extract', 'capture'], ['memocap capture commit', 'capture'],
    ['memocap maintenance review', 'maintenance'], ['memocap maintenance commit', 'maintenance']]);
  function check(review) { requireStage(clock() - review.started < review.timeout_ms, 'review_deadline'); }
  function start(active, workflow, milliseconds) {
    requireStage(milliseconds === undefined || milliseconds === (workflow === 'capture' ? profile.capture_ms : profile.maintenance_ms), 'capture_execution_profile_mismatch');
    const key = `${active.root}/${active.user}/${workflow}`;
    requireStage(!reviews.has(key), 'review_execution_rearmed');
    const owner = { ...active, workflow, review: key, started: clock(), children: 0, generations: 0, writes: 0,
      timeout_ms: workflow === 'capture' ? profile.capture_ms : profile.maintenance_ms };
    reviews.set(key, owner); return owner;
  }
  function child(active, title) {
    const workflow = stages.get(title);
    requireStage(active && workflow, 'child_binding_or_budget');
    const key = `${active.root}/${active.user}/${workflow}`;
    if (!reviews.has(key)) start(active, workflow);
    const owner = reviews.get(key);
    check(owner);
    requireStage(owner.children < 2, 'child_binding_or_budget');
    owner.children++;
    return owner;
  }
  function generation(owner) {
    check(owner);
    requireStage(owner.generations < 3, 'review_generation_budget');
    owner.generations++;
  }
  function dispatch(event) {
    const owner = reviews.get(`${event.root}/${event.user}/${event.workflow}`);
    requireStage(owner && identifier(event.session), 'write_workflow_unobserved');
    check(owner);
    requireStage(owner.writes < 1, 'review_write_budget');
    owner.writes++;
  }
  return { start, child, generation, dispatch, snapshot: () => structuredClone([...reviews.values()]) };
}
module.exports = { createWorkflows };
