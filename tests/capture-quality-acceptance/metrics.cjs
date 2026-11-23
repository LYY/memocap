function metric(numerator, denominator, reasons, run) {
  const missing = [...new Set(reasons)];
  const status = !run ? 'not_run' : missing.length ? 'blocked' : denominator === 0 ? 'not_applicable' : 'observed';
  return { status, numerator: status === 'observed' || status === 'not_applicable' ? numerator : null,
    denominator: run ? denominator : null, value: status === 'observed' ? numerator / denominator : null,
    adjudicated_numerator: run ? numerator : null, missing };
}
const missingJudgments = (rows) => rows.flatMap((row) => row.judgment_missing);
const caseAdmitted = (row) => row.required_case_rule === null || row.case_rule_judgment?.status === 'satisfied';
const correct = (row) => row.verified && !row.judgment_missing.length && row.judgment?.context === 'valid' &&
  row.judgment.durability === 'durable' && row.judgment.claims.every((claim) => claim.support === 'supported') &&
  !row.admission_omission_missing.length && row.judgment.conditions.every((condition) =>
    condition.preserved || row.admission_partial_conditions.includes(condition.id)) && caseAdmitted(row);
function metrics(inventory, labels, run) {
  const missingCases = inventory.cases.flatMap((row) => row.missing.map((reason) => `${row.id}:${reason}`));
  const eligibilityMissing = inventory.cases.filter((row) => row.eligibility_known === false).map((row) => `${row.id}:eligibility_unscored`);
  const captureKnown = !inventory.cases.some((row) => row.lane === 'capture' && row.eligibility_known === false);
  const maintenanceKnown = !inventory.cases.some((row) => row.lane === 'maintenance' && row.eligibility_known === false);
  const baseline = [...inventory.issues, ...missingCases, ...labels.issues, ...eligibilityMissing];
  const attempts = inventory.attempts.filter((row) => row.lane !== 'maintenance');
  const unknownWrites = attempts.filter((row) => !row.verified);
  const persistence = unknownWrites.flatMap((row) => row.missing.map((reason) => `${row.key}:${reason}`));
  const outputs = labels.outputs;
  const outputMissing = [...baseline, ...persistence, ...labels.outputs_issues, ...missingJudgments(outputs)];
  const semanticMissing = outputs.filter((row) => row.judgment?.context === 'unknown' || row.judgment?.durability === 'unknown' ||
    row.judgment?.claims?.some((claim) => claim.support === 'unknown')).map((row) => `${row.key}:semantic_unknown`);
  const coverageMissing = [...outputMissing, ...semanticMissing, ...outputs.flatMap((row) => row.case_rule_missing),
    ...outputs.filter((row) => row.case_rule_judgment?.status === 'unknown').map((row) => `${row.key}:case_rule_unknown`)];
  const admissionMissing = [...coverageMissing, ...outputs.flatMap((row) => row.admission_omission_missing)];
  const positives = inventory.cases.filter((row) => row.lane === 'capture' && row.gold?.action === 'save');
  const covered = (item) => new Set(outputs.filter((row) => row.case_id === item.id && row.verified &&
    !row.judgment_missing.length && row.judgment.context === 'valid' && row.judgment.durability === 'durable' && row.judgment.conditions.every((condition) => condition.preserved) && caseAdmitted(row))
    .flatMap((row) => row.judgment.claims.filter((claim) => claim.gold_claim !== null && claim.support === 'supported').map((claim) => claim.gold_claim)));
  const capture = {};
  capture.capture_admission_precision = metric(outputs.filter(correct).length, unknownWrites.length ? null : outputs.length,
    admissionMissing, run);
  capture.capture_opportunity_coverage = metric(positives.filter((item) => covered(item).size === item.claim_ids.length).length,
    captureKnown ? positives.length : null, coverageMissing, run);
  capture.atomic_claim_coverage = metric(positives.reduce((sum, item) => sum + covered(item).size, 0),
    captureKnown ? positives.reduce((sum, item) => sum + item.claim_ids.length, 0) : null, coverageMissing, run);
  const claims = outputs.flatMap((row) => row.judgment?.claims ?? []);
  capture.incorrect_support_rate = metric(claims.filter((claim) => claim.support !== 'supported').length,
    missingJudgments(outputs).length || unknownWrites.length ? null : claims.length, outputMissing, run);
  const savedPositive = positives.filter((item) => outputs.some((row) => row.case_id === item.id));
  let retained = 0; let conditions = 0;
  for (const item of savedPositive) for (const condition of item.required_conditions) {
    conditions++;
    if (outputs.some((row) => row.case_id === item.id && !row.judgment_missing.length &&
      row.judgment.conditions.some((label) => label.id === condition.id && label.preserved))) retained++;
  }
  capture.condition_retention = metric(retained, conditions, outputMissing, run);
  for (const [name, relation, field] of [['false_continuity', ['different', 'unknown'], 'false_continuity'], ['false_split', ['same'], 'false_split']]) {
    const eligible = inventory.cases.filter((row) => relation.includes(row.gold?.continuity));
    const relevant = labels.reviews.filter((review) => eligible.some((item) => item.id === review.case_id) &&
      review.turn === inventory.cases.find((item) => item.id === review.case_id)?.turns && review.lane === 'capture');
    const reasons = [...baseline, ...labels.reviews_issues, ...missingJudgments(relevant)];
    for (const item of eligible) if (!relevant.some((review) => review.case_id === item.id && typeof review.judgment?.[field] === 'boolean')) reasons.push(`${item.id}:explicit_${field}_judgment_absent`);
    capture[name] = metric(new Set(relevant.filter((row) => row.judgment?.[field] === true).map((row) => row.case_id)).size, eligible.length, reasons, run);
  }
  const decisions = labels.decisions;
  capture.all_wrong_proposals = metric(labels.proposals.filter((row) => row.judgment?.correct === false).length,
    labels.proposals.length, [...baseline, ...labels.proposals_issues, ...missingJudgments(labels.proposals)], run);
  const issuedMissing = [...baseline, ...labels.decisions_issues, ...missingJudgments(decisions),
    ...decisions.flatMap((row) => row.missing.map((reason) => `${row.key}:${reason}`))];
  const issuanceUnknown = missingCases.some((reason) => reason.includes('issued:inventory_unobserved'));
  capture.maintenance_false_revision = metric(decisions.filter((row) => row.judgment?.correct === false).length, issuanceUnknown ? null : decisions.length, issuedMissing, run);
  const deletes = decisions.filter((row) => row.action === 'delete');
  capture.maintenance_false_delete = metric(deletes.filter((row) => row.judgment?.correct === false).length, issuanceUnknown ? null : deletes.length, issuedMissing, run);
  const authorized = inventory.cases.filter((row) => row.lane === 'maintenance' && row.gold?.mutations === 1);
  const successful = (item) => labels.mutations.some((mutation) => mutation.case_id === item.id && mutation.verified && mutation.issued_key &&
    !mutation.judgment_missing.length && decisions.some((decision) => decision.case_id === item.id && !decision.missing.length &&
      decision.key === mutation.issued_key && !decision.judgment_missing.length && decision.judgment.correct === true && decision.action === item.gold.action &&
      inventory.attempts.find((attempt) => attempt.key === mutation.attempt_key)?.dispatch?.request?.group?.action === (decision.action === 'update' ? 'refine' : decision.action)));
  const mutationMissing = [...baseline, ...labels.mutations_issues, ...missingJudgments(labels.mutations),
    ...inventory.attempts.filter((row) => row.lane === 'maintenance' && !row.verified).flatMap((row) => row.missing.map((reason) => `${row.key}:${reason}`))];
  capture.missed_maintenance = metric(authorized.filter((item) => !successful(item)).length, maintenanceKnown ? authorized.length : null,
    [...mutationMissing, ...issuedMissing, ...labels.mutations.flatMap((row) => row.linkage_missing)], run);
  const facts = labels.mutations.flatMap((mutation) => mutation.judgment?.participants?.flatMap((entry) => entry.facts ?? []) ?? []).filter((fact) => fact.still_valid);
  capture.maintenance_condition_loss = metric(facts.filter((fact) => !fact.preserved).length,
    missingJudgments(labels.mutations).length || inventory.attempts.some((row) => row.lane === 'maintenance' && !row.verified) ? null : facts.length, mutationMissing, run);
  capture.exact_duplicate_error = metric(0, null, ['trace.identity:explicit_comparison_decision_absent', 'identical_replay:unexercised'], run);
  const reviewed = labels.reviews;
  capture.unknown_rate = metric(new Set(reviewed.filter((row) => row.judgment?.unknown === true).map((row) => row.case_id)).size,
    new Set(reviewed.map((row) => row.case_id)).size, [...baseline, ...labels.reviews_issues, ...missingJudgments(reviewed)], run);
  return capture;
}
module.exports = { metric, metrics };
