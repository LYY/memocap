const { inventory } = require('./inventory.cjs');
const { judgments } = require('./judgments.cjs');
const { metrics } = require('./metrics.cjs');
const { accounting, groups } = require('./statistics.cjs');
const { selectDefinitions, bindResult, hash } = require('./definitions.cjs');
function collect(result, annotations = {}, evaluation) {
  const selected = selectDefinitions(evaluation); bindResult(result, selected);
  const { tuning_sha256, scoring } = selected;
  const observed = inventory(result, selected);
  const labels = judgments(observed, annotations);
  const run = result != null;
  const values = metrics(observed, labels, run);
  const captureKnown = selected.cases.filter((row) => row.lane === 'capture').every((row) => row.eligibility_known);
  const maintenanceKnown = selected.cases.filter((row) => row.lane === 'maintenance').every((row) => row.eligibility_known);
  const actual = run && observed.cases.every((row) => row.runtime === 'requires_independent_runtime_adjudication');
  return { schema: 1, kind: 'offline_receipt_adjudication', input_kind: result?.kind ?? null,
    actual_quality: { status: actual ? 'blocked' : 'not_run', value: null, acceptance: null,
      reason: actual ? 'No gate selected; incomplete trace metrics remain blocked; adjudication is independent input.' : 'No genuine native result supplied; synthetic fixture scores are not measured quality.' },
    inventory: { ...observed, wrong_proposals: labels.proposals.filter((row) => row.judgment?.correct === false),
      outputs: labels.outputs, decisions: labels.decisions, mutations: labels.mutations },
    metrics: values, groups: groups(observed, labels, run), accounting: accounting(observed, run),
    identity: { evaluation: selected.evaluation, distinct_claims: selected.evaluation ? null : { case_id: 'same-source-distinct-claims', opportunities: 1, atomic_claims: 2 },
      identical_replay: { exercise: 'unexercised', reason: 'No explicit replay observation supplied.' } },
    annotations: { provenance: labels.provenance, rejected: labels.rejected, issues: [...labels.issues, ...['outputs', 'decisions', 'proposals', 'reviews', 'mutations'].flatMap((name) =>
      [...labels[`${name}_issues`] ?? [], ...labels[name].flatMap((row) => row.judgment_missing)])],
      independence: 'Declared adjudicator provenance is inspectable; code cannot establish independence or natural-language truth.' },
    freeze: { tuning_sha256, scoring, annotation_sha256: hash(annotations), gate: null, holdout: 'not_loaded',
      evaluation: selected.evaluation, planned: {
        capture_cases: selected.cases.filter((row) => row.lane === 'capture').length,
        maintenance_cases: selected.cases.filter((row) => row.lane === 'maintenance').length,
        capture_opportunities: captureKnown ? selected.cases.filter((row) => row.lane === 'capture' && row.gold.action === 'save').length : null,
        capture_claims: captureKnown ? selected.cases.reduce((sum, row) => sum + row.claim_ids.length, 0) : null,
        authorized_maintenance: maintenanceKnown ? selected.cases.filter((row) => row.lane === 'maintenance' && row.gold.mutations === 1).length : null } } };
}
module.exports = { collect };
