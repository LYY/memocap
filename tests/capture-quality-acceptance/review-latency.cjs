const finite = (number) => typeof number === 'number' && Number.isFinite(number) && number >= 0;
const validClock = (domain) => typeof domain === 'string' && /^node\.performance:\d+(?:\.\d+)?$/.test(domain) &&
  finite(Number(domain.slice('node.performance:'.length)));
function reviewLatency(inventory, run, quantile) {
  const attempts = inventory.reviews.map((review) => {
    const starts = review.events.filter(({ kind }) => kind === 'review.started');
    const finishes = review.events.filter(({ kind }) => kind === 'review.finished');
    const start = starts[0]; const finish = finishes[0]; const missing = [...review.missing];
    if (starts.length !== 1 || finishes.length !== 1) missing.push('review:unique_start_finish_absent');
    const identity = JSON.stringify([review.root, review.user, review.lane]);
    const summary = review.summaries.length === 1 ? review.summaries[0] : null;
    const normalSkip = finish?.status === 'skipped' && summary?.status === 'skipped' && review.lane === 'capture' && !review.semantic &&
      ['no_evidence', 'evidence_budget'].includes(finish.reason) && summary.reason === finish.reason &&
      ['model_calls', 'tool_calls', 'write_attempts'].every((field) => finish[field] === 0 && summary[field] === 0);
    const normalEmpty = review.lane === 'capture' && review.semantic &&
      [finish, summary].every((terminal) => terminal?.status === 'skipped' && terminal.reason === 'no_candidate' &&
        terminal.model_calls === 1 && terminal.tool_calls === 0 && terminal.write_attempts === 0);
    if (!start || !finish || start.review_id !== identity || finish.review_id !== identity ||
      !validClock(start.clock_domain) || start.clock_domain !== finish.clock_domain ||
      !finite(start.monotonic_ms) || !finite(finish.monotonic_ms) || finish.monotonic_ms < start.monotonic_ms ||
      finish.event_index <= start.event_index) missing.push('review:clock_identity_or_order');
    if (!finish || !normalSkip && !normalEmpty && !['saved', 'no_candidate', 'duplicate', 'rejected', 'proposal', 'denied', 'keep', 'not_queued', 'reevaluate', 'applied', 'committed'].includes(finish.status) ||
      review.summaries.length !== 1 || review.summaries[0].status !== finish?.status) missing.push(`review:outcome:${finish?.status ?? 'missing'}`);
    const duration = missing.length ? null : finish.monotonic_ms - start.monotonic_ms;
    return { key: review.key, case_id: review.case_id, root: review.root, user: review.user, workflow: review.lane,
      semantic: review.semantic, status: finish?.status ?? null, clock_domain: start?.clock_domain ?? null,
      duration_ms: duration, missing };
  });
  const missing = [...inventory.issues, ...inventory.cases.flatMap((row) => row.missing.map((reason) => `${row.id}:${reason}`)),
    ...attempts.flatMap((row) => row.missing.map((reason) => `${row.key}:${reason}`))];
  const samples = attempts.filter((row) => row.semantic && !row.missing.length).map((row) => row.duration_ms);
  return { status: !run ? 'not_run' : missing.length ? 'blocked' : samples.length ? 'complete' : 'not_applicable',
    p50: missing.length ? null : quantile(samples, 0.5), p95: missing.length ? null : quantile(samples, 0.95), samples,
    attempts, pre_model: attempts.filter((row) => !row.semantic), missing,
    estimator: 'nearest-rank: ascending[ceil(p*n)-1]; p50=0.50,p95=0.95; empty=null',
    scope: 'whole_review_entry_through_terminal_after_recording_and_child_cleanup; semantic_samples_separate_from_attempts' };
}
module.exports = { reviewLatency, validClock };
