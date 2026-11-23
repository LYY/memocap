const { metric } = require('./metrics.cjs');
const { reviewLatency } = require('./review-latency.cjs');
const { dispatchStatistics } = require('./dispatch-statistics.cjs');
function quantile(samples, probability) {
  if (!samples.length) return null;
  return [...samples].sort((left, right) => left - right)[Math.ceil(probability * samples.length) - 1];
}
function accounting(inventory, run) {
  const responses = inventory.events.filter((event) => event.kind === 'model.response');
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const fields = ['input', 'output', 'reasoning', 'cache_read', 'cache_write'];
  const tokens = Object.fromEntries(fields.map((field) => [field, responses.length && responses.every((event) => finite(event.usage?.tokens?.[field]))
    ? responses.reduce((sum, event) => sum + event.usage.tokens[field], 0) : null]));
  const reported = responses.length && responses.every((event) => finite(event.usage?.reported_cost))
    ? responses.reduce((sum, event) => sum + event.usage.reported_cost, 0) : null;
  const dispatches = dispatchStatistics(inventory, run);
  return { dispatches: { native: inventory.events.filter((event) => event.kind === 'native.dispatch').length,
    model_responses: responses.length, provider: dispatches.provider, failed: dispatches.failed, status: dispatches.status,
    scope: 'observed_actual_dispatches_only; does_not_reconstruct_historical_requests', missing: dispatches.missing },
    tokens: { ...tokens, status: run ? 'blocked' : 'not_run', scope: 'observed_child_responses_only',
      missing: ['trace:all_dispatched_attempt_token_usage_absent', ...responses.flatMap((event) => fields.filter((field) => !finite(event.usage?.tokens?.[field])).map((field) => `${event.case_id}:${event.event_index}:tokens.${field}`))] },
    reported_child_cost: reported, cost: null, cost_status: run ? 'blocked' : 'not_run',
    cost_missing: ['trace:complete_actual_dispatch_cost_absent; reported_cost_is_partial'],
    corrected_run: dispatches.corrected_run, cumulative_cost: null,
    latency: reviewLatency(inventory, run, quantile) };
}
function groups(inventory, labels, run) {
  const keys = new Map();
  for (const row of [...inventory.cases, ...inventory.reviews, ...inventory.outputs, ...inventory.decisions]) {
    const key = JSON.stringify([row.family, row.lane, row.stratum]);
    if (!keys.has(key)) keys.set(key, { family: row.family, lane: row.lane, stratum: row.stratum });
  }
  return [...keys.values()].map((group) => {
    const belongs = (row) => row.family === group.family && row.lane === group.lane && row.stratum === group.stratum;
    const cases = inventory.cases.filter(belongs); const reviews = labels.reviews.filter(belongs);
    return { ...group, planned_case_ids: cases.map((row) => row.id), complete_case_ids: cases.filter((row) => row.complete).map((row) => row.id),
      counts: { planned: cases.length, complete: cases.filter((row) => row.complete).length, semantic_cases: new Set(reviews.map((row) => row.case_id)).size,
        outputs: inventory.outputs.filter(belongs).length, issued: inventory.decisions.filter(belongs).length, raw_proposals: inventory.proposals.filter(belongs).length },
      pre_model_case_ids: cases.filter((row) => row.observed && !reviews.some((review) => review.case_id === row.id)).map((row) => row.id),
      review_ids: inventory.reviews.filter(belongs).map((row) => row.key), output_ids: inventory.outputs.filter(belongs).map((row) => row.key),
      issued_ids: inventory.decisions.filter(belongs).map((row) => row.key), proposal_ids: inventory.proposals.filter(belongs).map((row) => row.key),
      unknown: metric(new Set(reviews.filter((row) => row.judgment?.unknown === true).map((row) => row.case_id)).size,
        new Set(reviews.map((row) => row.case_id)).size, [...labels.issues, ...labels.reviews_issues,
          ...cases.flatMap((row) => row.missing), ...reviews.flatMap((row) => row.judgment_missing)], run),
      missing: cases.flatMap((row) => row.missing.map((reason) => `${row.id}:${reason}`)) };
  });
}
module.exports = { quantile, accounting, groups };
