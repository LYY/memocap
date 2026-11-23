const fields = ['input', 'output', 'reasoning', 'cache_read', 'cache_write'];
const { validClock } = require('./review-latency.cjs');
const finite = (number) => typeof number === 'number' && Number.isFinite(number) && number >= 0;
function dispatchStatistics(inventory, run) {
  const events = inventory.events;
  const relevant = events.filter((event) => ['provider.dispatch', 'provider.finished'].includes(event.kind));
  const starts = relevant.filter(({ kind }) => kind === 'provider.dispatch');
  const ids = new Set(relevant.filter((event) => event.dispatch_id).map((event) => JSON.stringify([event.case_id, event.dispatch_id])));
  const missing = [...inventory.issues, ...inventory.cases.flatMap((row) => row.missing.map((reason) => `${row.id}:${reason}`))]; const attempts = [];
  for (const key of ids) {
    const related = relevant.filter((event) => JSON.stringify([event.case_id, event.dispatch_id]) === key);
    const parts = (kind) => related.filter((event) => event.kind === kind);
    const dispatches = parts('provider.dispatch'); const finishes = parts('provider.finished');
    const start = dispatches[0]; const finish = finishes[0]; const reasons = [];
    const sameOwner = (event) => event && start && event.case_id === start.case_id && event.root === start.root &&
      event.user === start.user && event.workflow === start.workflow;
    if (dispatches.length !== 1 || finishes.length !== 1 || starts.filter((other) => other.dispatch_id === start?.dispatch_id).length !== 1 ||
      typeof start?.root !== 'string' || !start.root ||
      typeof start.user !== 'string' || !start.user || !sameOwner(finish) ||
      !finite(start.monotonic_ms) || !finite(finish?.monotonic_ms) || finish.monotonic_ms < start.monotonic_ms ||
      !validClock(start.clock_domain) || start.clock_domain !== finish.clock_domain ||
      !Number.isInteger(start.event_index) || !Number.isInteger(finish?.event_index) ||
      finish.event_index <= start.event_index) reasons.push('dispatch:unique_clock_pair_absent');
    if (finish?.outcome !== 'response' || !Number.isInteger(finish.status) || finish.status < 200 || finish.status >= 300) reasons.push('dispatch:response_unknown_or_failed');
    const terminal = finish?.terminal; const usage = terminal?.usage;
    if (terminal?.dialect !== 'responses' || terminal.status !== 'completed') reasons.push('dispatch:terminal_usage_proof_absent');
    if (fields.some((field) => usage?.token_states?.[field] === 'observed' ? !finite(usage?.tokens?.[field]) :
      usage?.token_states?.[field] !== 'absent' || usage?.tokens?.[field] !== null) ||
      ['input', 'output'].some((field) => usage?.token_states?.[field] !== 'observed')) reasons.push('dispatch:usage_unknown');
    attempts.push({ key, dispatch_id: start?.dispatch_id ?? null, root: start?.root ?? null, user: start?.user ?? null,
      outcome: finish?.outcome ?? null, http_status: Number.isInteger(finish?.status) ? finish.status : null,
      terminal_status: terminal?.dialect === 'responses' ? terminal.status : 'unknown',
      usage: reasons.length ? null : usage, missing: reasons });
    missing.push(...reasons.map((reason) => `${key}:${reason}`));
  }
  if (!starts.length) missing.push('dispatch:inventory_absent');
  if (relevant.some((event) => !event.dispatch_id)) missing.push('dispatch:uncorrelated_evidence');
  const complete = starts.length > 0 && !missing.length;
  const pairs = attempts.filter((attempt) => attempt.usage);
  const tokens = Object.fromEntries(fields.map((field) => [field, complete && pairs.every((pair) => pair.usage.token_states[field] === 'observed')
    ? pairs.reduce((sum, pair) => sum + pair.usage.tokens[field], 0) : null]));
  const partial = complete && fields.some((field) => tokens[field] === null);
  const transportComplete = starts.length > 0 && attempts.length === starts.length && attempts.every((attempt) =>
    !attempt.missing.includes('dispatch:unique_clock_pair_absent') && (attempt.outcome === 'failed' ||
      attempt.outcome === 'response' && attempt.http_status >= 100 && attempt.http_status < 600));
  return { provider: starts.length && starts.every((start) => start.dispatch_id && starts.filter((other) =>
    other.dispatch_id === start.dispatch_id).length === 1) ? starts.length : null,
    failed: transportComplete ? attempts.filter((attempt) => attempt.outcome === 'failed' ||
      attempt.http_status < 200 || attempt.http_status >= 300 || ['incomplete', 'failed'].includes(attempt.terminal_status)).length : null,
    status: !run ? 'not_run' : complete ? 'observed' : 'blocked', missing,
    corrected_run: { status: !run ? 'not_run' : partial ? 'partial' : complete ? 'complete' : 'blocked', scope: 'observed_actual_dispatches_only',
      usage_pairs: pairs.length, attempts, tokens,
      token_states: Object.fromEntries(fields.map((field) => [field, tokens[field] === null ? 'unknown' : 'observed'])),
      billing_total: null, token_basis: 'provider_categories_not_proven_disjoint; never_add_input_output_reasoning_cache_as_billing',
      cost: null, cost_status: 'blocked', missing: [...missing, ...fields.filter((field) => tokens[field] === null).map((field) => `tokens.${field}:unknown`),
        'provider_price_unknown; historical_financial_total_unknown'] } };
}
module.exports = { dispatchStatistics };
