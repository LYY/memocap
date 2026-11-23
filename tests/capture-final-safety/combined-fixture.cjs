const path = require('node:path');
const proof = require('./observations.cjs');

const selector = 'recursive worker prompts and all persisted activity stay bounded on the real host';
// Allow for 25s dispose, 3s kill escalation, port checks, and local teardown.
const cleanupBudgetMs = 40_000;

async function finalize(context, { directory, evidence, current, maintenance, failure }) {
  const cleanup = evidence.cleanup;
  if (maintenance) evidence.maintenance_telemetry = { events: maintenance.control.events, provider_requests: maintenance.provider.requests };
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Fixture close did not settle within ${cleanupBudgetMs} ms`)), cleanupBudgetMs);
  });
  const closes = [['maintenance', maintenance], ['capture', current]].map(async ([name, fixture]) => {
    if (!fixture) return;
    try {
      await Promise.race([fixture.close(), deadline]);
    } catch (error) {
      return { fixture: name, error: error instanceof Error ? error.stack : String(error) };
    }
  });
  const errors = (await Promise.all(closes).finally(() => clearTimeout(timer))).filter(Boolean);
  const captureClean = !current || (cleanup.host_port_closed === true && cleanup.provider_port_closed === true &&
    cleanup.control_port_closed === true && cleanup.package?.active_children === 0 &&
    cleanup.package.registry_closed === true && cleanup.package.sandbox_removed === true &&
    cleanup.scratch_dependency_link_removed === true && !cleanup.dispose_error);
  const maintenanceCleanup = evidence.maintenance?.cleanup;
  const maintenanceClean = !maintenance || (maintenanceCleanup?.host_port_closed === true &&
    maintenanceCleanup.provider_port_closed === true && maintenanceCleanup.control_port_closed === true &&
    maintenanceCleanup.sandbox_removed === true && !maintenanceCleanup.dispose_error);
  cleanup.status = errors.length > 0 || !captureClean || !maintenanceClean ? 'warning' :
    current || maintenance ? 'clean' : 'not_applicable';
  cleanup.errors = errors;
  cleanup.process_enumeration = 'not_attempted';

  let hardFailure = failure;
  if (hardFailure === undefined && evidence.status === 'observed') {
    try {
      proof.record(evidence, 'recursion', { case_id: selector, denominator: evidence.cases.find((entry) => entry.case_id === 'recursion').attempts.length, violations: 0 });
      proof.record(evidence, 'activity_leak', { case_id: selector,
        denominator: evidence.capture_checked.comparisons + evidence.maintenance_checked.comparisons, violations: 0 });
      evidence.status = 'passed';
    } catch (error) { hardFailure = error; }
  }
  if (hardFailure !== undefined) {
    evidence.status = 'failed';
    evidence.error = hardFailure instanceof Error ? hardFailure.stack : String(hardFailure);
    evidence.safety_observations.length = 0;
  }
  try {
    // Serialize once, before a close that missed the deadline can update fixture telemetry.
    proof.persist(directory, evidence);
    context.diagnostic(JSON.stringify({ artifact: path.join(directory, 'observations.json'), status: evidence.status,
      cleanup_status: cleanup.status }));
  } catch (error) {
    if (hardFailure === undefined) throw error;
    context.diagnostic(`Could not persist final safety observations: ${error}`);
  }
  if (hardFailure !== undefined) throw hardFailure;
}

module.exports = { finalize, selector };
