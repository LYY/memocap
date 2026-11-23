const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('./index.cjs');
const { population, annotations } = require('./examples.cjs');
function measured() {
  const result = population();
  for (const row of result.cases) for (const turn of row.turns) for (const summary of turn.result.reviews) {
    const identity = { root: summary.parentID, user: summary.user_id, workflow: summary.workflow,
      review_id: JSON.stringify([summary.parentID, summary.user_id, summary.workflow]), clock_domain: 'node.performance:42' };
    row.trace.events.push({ ...identity, kind: 'review.started', monotonic_ms: 10 },
      { ...identity, kind: 'review.finished', monotonic_ms: 40060, status: summary.status });
  }
  const row = result.cases[0]; const summary = row.turns[0].result.reviews[0];
  const owner = { root: summary.parentID, user: summary.user_id, workflow: summary.workflow, session: 'child' };
  const attempt = { root: owner.root, user: owner.user, workflow: null, dispatch_id: 'dispatch', clock_domain: 'node.performance:43' };
  row.trace.events.push({ ...attempt, kind: 'provider.dispatch', monotonic_ms: 1 },
    { ...attempt, kind: 'provider.finished', monotonic_ms: 2, outcome: 'response', status: 200,
      terminal: { dialect: 'responses', status: 'completed', usage: { reported_cost: null,
        tokens: { input: 10, output: 2, reasoning: 1, cache_read: 8, cache_write: 0 },
        token_states: { input: 'observed', output: 'observed', reasoning: 'observed', cache_read: 'observed', cache_write: 'observed' } } } },
    { ...owner, kind: 'provider.link', dispatch_id: 'dispatch' },
    { ...owner, kind: 'model.response', dispatch_id: 'dispatch', usage: { reported_cost: null,
      tokens: { input: 10, output: 2, reasoning: 1, cache_read: 8, cache_write: 0 } } });
  return result;
}
test('public collector measures full review clocks separately from pre-model attempts and response latency', () => {
  const report = collect(measured(), annotations());
  assert.equal(report.accounting.latency.p50, 40050); assert.equal(report.accounting.latency.p95, 40050);
  assert.equal(report.accounting.latency.attempts.length, 32); assert.equal(report.accounting.latency.pre_model.length, 31);
  assert.equal(report.inventory.reviews.length, 32);
});
test('actual terminal usage retains five categories without a synthetic billing total', () => {
  const report = collect(measured(), annotations()).accounting;
  assert.equal(report.dispatches.provider, 1); assert.equal(report.dispatches.failed, 0);
  assert.equal(report.corrected_run.usage_pairs, 1);
  assert.deepEqual(report.corrected_run.tokens, { input: 10, output: 2, reasoning: 1, cache_read: 8, cache_write: 0 });
  assert.equal(report.corrected_run.billing_total, null); assert.equal(report.cost, null);
  assert.equal(report.corrected_run.cost, null); assert.equal(report.cumulative_cost, null);
});
for (const variant of ['duplicate_summary', 'contradictory_summary', 'missing_summary', 'invalid_root', 'invalid_user',
  'empty_epoch', 'nan_epoch', 'infinite_epoch', 'negative_epoch']) test(`ambiguous or invalid review ${variant} blocks semantic quantiles`, () => {
  const result = measured(); const row = result.cases[0]; const summaries = row.turns[0].result.reviews;
  switch (variant) {
    case 'duplicate_summary': summaries.push(structuredClone(summaries[0])); break;
    case 'contradictory_summary': summaries.push({ ...summaries[0], status: 'cancelled' }); break;
    case 'missing_summary': summaries.length = 0; break;
    case 'invalid_root': case 'invalid_user': {
      const field = variant === 'invalid_root' ? 'root' : 'user'; const value = 42;
      summaries[0][field === 'root' ? 'parentID' : 'user_id'] = value;
      for (const event of row.trace.events) { event[field] = value;
        if (event.kind.startsWith('review.')) event.review_id = JSON.stringify([event.root, event.user, event.workflow]); }
      break;
    }
    default: {
      const suffix = { empty_epoch: '', nan_epoch: 'NaN', infinite_epoch: 'Infinity', negative_epoch: '-1' }[variant];
      for (const event of row.trace.events.filter(({ kind }) => kind.startsWith('review.'))) event.clock_domain = `node.performance:${suffix}`;
    }
  }
  const latency = collect(result, annotations()).accounting.latency;
  assert.equal(latency.status, 'blocked'); assert.equal(latency.p50, null); assert.equal(latency.p95, null);
});
for (const variant of ['missing', 'duplicate', 'out_of_order', 'different_domain', 'different_parent', 'unknown', 'cancelled', 'missing_status', 'conflicting_status']) test(`review ${variant} remains blocked without inferred durations`, () => {
  const result = measured(); const events = result.cases[0].trace.events;
  switch (variant) {
    case 'missing': events.splice(0, 1); break;
    case 'duplicate': events.push(structuredClone(events[0])); break;
    case 'out_of_order': events[1].monotonic_ms = 0; break;
    case 'different_domain': events[1].clock_domain = 'other'; break;
    case 'different_parent': events[1].root = 'other'; break;
    case 'unknown': events[1].status = 'unknown'; break;
    case 'cancelled': events[1].status = 'cancelled'; break;
    case 'missing_status': delete events[1].status; break;
    case 'conflicting_status': events[1].status = 'saved'; break;
  }
  const latency = collect(result, annotations()).accounting.latency;
  assert.equal(latency.status, 'blocked'); assert.equal(latency.p50, null); assert.equal(latency.p95, null);
});
for (const variant of ['missing', 'duplicate', 'out_of_order', 'foreign', 'unknown_tokens', 'failed', 'missing_terminal_proof', 'incomplete_population']) test(`dispatch ${variant} never manufactures complete usage`, () => {
  const result = measured(); const events = result.cases[0].trace.events;
  const start = events.find(({ kind }) => kind === 'provider.dispatch');
  const response = events.find(({ kind }) => kind === 'provider.finished');
  switch (variant) {
    case 'missing': events.splice(events.indexOf(start), 1); break;
    case 'duplicate': events.push(structuredClone(response)); break;
    case 'out_of_order': events.find(({ kind }) => kind === 'provider.finished').monotonic_ms = 0; break;
    case 'foreign': response.user = 'foreign'; break;
    case 'unknown_tokens': response.terminal.usage.tokens.input = null; break;
    case 'failed': response.outcome = 'failed'; delete response.terminal; break;
    case 'missing_terminal_proof': delete response.terminal; break;
    case 'incomplete_population': result.population_status = 'incomplete'; break;
  }
  const report = collect(result, annotations()).accounting;
  assert.equal(report.corrected_run.status, 'blocked'); assert.equal(report.corrected_run.tokens.input, null);
  assert.equal(report.cost, null);
  if (variant === 'failed') assert.equal(report.dispatches.failed, 1);
});
test('independent zero-token SDK reply cannot satisfy actual transport usage', () => {
  const result = measured(); const events = result.cases[0].trace.events;
  delete events.find(({ kind }) => kind === 'provider.finished').terminal;
  const reply = events.find(({ kind }) => kind === 'model.response'); reply.dispatch_id = null;
  reply.usage.tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  const report = collect(result, annotations()).accounting;
  assert.equal(report.corrected_run.tokens.input, null); assert.equal(report.corrected_run.usage_pairs, 0);
});
test('terminal proof alone establishes totals while absent details remain partial and independent SDK replies stay unpaired', () => {
  const result = measured(); const events = result.cases[0].trace.events;
  for (const event of events.filter(({ kind }) => ['model.response', 'provider.link'].includes(kind))) event.dispatch_id = null;
  const usage = events.find(({ kind }) => kind === 'provider.finished').terminal.usage;
  for (const field of ['reasoning', 'cache_write']) { usage.tokens[field] = null; usage.token_states[field] = 'absent'; }
  const report = collect(result, annotations()).accounting.corrected_run;
  assert.equal(report.status, 'partial'); assert.equal(report.usage_pairs, 1);
  assert.deepEqual(report.tokens, { input: 10, output: 2, reasoning: null, cache_read: 8, cache_write: null });
  assert.deepEqual(report.token_states, { input: 'observed', output: 'observed', reasoning: 'unknown', cache_read: 'observed', cache_write: 'unknown' });
});
for (const status of ['incomplete', 'failed']) test(`validated Responses ${status} counts as failed without successful usage`, () => {
  const result = measured(); result.cases[0].trace.events.find(({ kind }) => kind === 'provider.finished').terminal.status = status;
  const report = collect(result, annotations()).accounting;
  assert.equal(report.dispatches.failed, 1); assert.equal(report.corrected_run.tokens.input, null);
});
test('dispatch UUID reused across cases cannot establish unique provenance', () => {
  const result = measured(); const rows = result.cases[0].trace.events.filter(({ kind }) => kind.startsWith('provider.'));
  result.cases[1].trace.events.push(...structuredClone(rows));
  const report = collect(result, annotations()).accounting;
  assert.equal(report.dispatches.provider, null); assert.equal(report.corrected_run.tokens.input, null);
});
test('legacy response-only evidence stays partial with unknown dispatches clocks and financial total', () => {
  const result = population(); result.cases[0].trace.events.push({ kind: 'model.response', root: 'read-route', user: 'u1', workflow: 'capture',
    usage: { tokens: { input: 163053, output: 3756, reasoning: 2519, cache_read: 155648, cache_write: 0 }, latency_ms: 17 } });
  const report = collect(result, annotations()).accounting;
  assert.equal(report.tokens.input, 163053); assert.equal(report.tokens.status, 'blocked');
  assert.equal(report.dispatches.provider, null); assert.equal(report.latency.p50, null); assert.equal(report.cost, null);
});
test('failed dispatch and model-call attempt counter do not establish a semantic review sample', () => {
  const result = measured(); const row = result.cases[0];
  row.trace.events = row.trace.events.filter(({ kind }) => !['model.response', 'provider.link'].includes(kind));
  row.trace.events.find(({ kind }) => kind === 'provider.finished').outcome = 'failed';
  row.turns[0].result.reviews[0].model_calls = 1;
  const report = collect(result, annotations());
  assert.equal(report.inventory.reviews.filter(({ semantic }) => semantic).length, 0);
  assert.equal(report.accounting.latency.samples.length, 0);
  assert.equal(report.accounting.latency.pre_model.length, 32);
});
for (const variant of ['absent', 'missing_terminal', 'duplicate_terminal', 'unknown_terminal']) test(`dispatch failure count stays unknown for ${variant} transport evidence`, () => {
  const result = variant === 'absent' ? population() : measured(); const events = result.cases[0].trace.events;
  const finish = events.find(({ kind }) => kind === 'provider.finished');
  switch (variant) {
    case 'absent': break;
    case 'missing_terminal': events.splice(events.indexOf(finish), 1); break;
    case 'duplicate_terminal': events.push(structuredClone(finish)); break;
    case 'unknown_terminal': finish.outcome = 'unknown'; break;
  }
  assert.equal(collect(result, annotations()).accounting.dispatches.failed, null);
});
test('observed non-success HTTP response counts a failed dispatch without inventing usage', () => {
  const result = measured(); const events = result.cases[0].trace.events;
  events.find(({ kind }) => kind === 'provider.finished').status = 503;
  const report = collect(result, annotations()).accounting;
  assert.equal(report.dispatches.failed, 1); assert.equal(report.corrected_run.tokens.input, null);
});
test('public collector measures a normal semantic skipped no_candidate review', () => {
  const result = measured(); const row = result.cases[0];
  const summary = row.turns[0].result.reviews[0];
  Object.assign(summary, { status: 'skipped', reason: 'no_candidate', model_calls: 1, tool_calls: 0, write_attempts: 0 });
  Object.assign(row.trace.events[1], summary);
  const latency = collect(result, {}).accounting.latency;
  assert.equal(latency.status, 'complete'); assert.deepEqual(latency.samples, [40050]);
  assert.equal(latency.p50, 40050); assert.equal(latency.p95, 40050);
  assert.equal(latency.pre_model.length, 31); assert.deepEqual(latency.attempts[0].missing, []);
});
for (const variant of ['unknown', 'capture_timeout', 'cancelled', 'denied', 'reason_conflict', 'missing_counts',
  'zero_model', 'extra_model', 'fractional_model', 'tool', 'write', 'counter_conflict', 'nonsemantic', 'maintenance',
  'duplicate_summary', 'missing_summary', 'duplicate_finish', 'clock', 'owner', 'order']) test(`semantic no_candidate ${variant} blocks latency`, () => {
  const result = measured(); const row = result.cases[0]; const summary = row.turns[0].result.reviews[0];
  Object.assign(summary, { status: 'skipped', reason: 'no_candidate', model_calls: 1, tool_calls: 0, write_attempts: 0 });
  Object.assign(row.trace.events[1], summary);
  const finish = row.trace.events[1];
  switch (variant) {
    case 'unknown': case 'capture_timeout': case 'denied': summary.reason = finish.reason = variant; break;
    case 'cancelled': summary.status = finish.status = variant; break;
    case 'reason_conflict': finish.reason = 'no_evidence'; break;
    case 'missing_counts': delete summary.tool_calls; delete finish.tool_calls; break;
    case 'zero_model': summary.model_calls = finish.model_calls = 0; break;
    case 'extra_model': summary.model_calls = finish.model_calls = 2; break;
    case 'fractional_model': summary.model_calls = finish.model_calls = 1.5; break;
    case 'tool': summary.tool_calls = finish.tool_calls = 1; break;
    case 'write': summary.write_attempts = finish.write_attempts = 1; break;
    case 'counter_conflict': finish.model_calls = 0; break;
    case 'nonsemantic': row.trace.events = row.trace.events.filter(({ kind }) => kind.startsWith('review.')); break;
    case 'maintenance': {
      summary.workflow = 'maintenance';
      for (const event of row.trace.events) if (event.workflow === 'capture') {
        event.workflow = 'maintenance'; event.review_id = JSON.stringify([event.root, event.user, event.workflow]);
      }
      break;
    }
    case 'duplicate_summary': row.turns[0].result.reviews.push(structuredClone(summary)); break;
    case 'missing_summary': row.turns[0].result.reviews.length = 0; break;
    case 'duplicate_finish': row.trace.events.push(structuredClone(finish)); break;
    case 'clock': finish.clock_domain = 'other'; break;
    case 'owner': finish.review_id = 'other'; break;
    case 'order': finish.monotonic_ms = 0; break;
  }
  const latency = collect(result, {}).accounting.latency;
  assert.equal(latency.status, 'blocked'); assert.equal(latency.p50, null); assert.equal(latency.p95, null);
});
for (const reason of ['no_evidence', 'evidence_budget']) test(`normal ${reason} CaptureStop stays a completed pre-model attempt`, async () => {
  const { CaptureStop } = await import('../../plugin/capture/contract.js');
  const stop = new CaptureStop(reason); const result = measured(); const row = result.cases[0];
  row.trace.events = row.trace.events.filter(({ kind }) => kind.startsWith('review.'));
  Object.assign(row.turns[0].result.reviews[0], { status: stop.status, reason: stop.code, model_calls: 0, tool_calls: 0, write_attempts: 0 });
  Object.assign(row.trace.events[1], row.turns[0].result.reviews[0]);
  const latency = collect(result, annotations()).accounting.latency;
  assert.equal(latency.status, 'not_applicable'); assert.deepEqual(latency.samples, []);
  assert.equal(latency.pre_model.length, 32); assert.equal(latency.attempts[0].duration_ms, 40050);
  assert.deepEqual(latency.attempts[0].missing, []);
});
for (const variant of ['unknown', 'capture_timeout', 'new_input', 'missing_counts', 'model', 'write', 'reason_conflict']) test(`skipped ${variant} cannot become a completed latency sample`, () => {
  const result = measured(); const row = result.cases[0];
  row.trace.events = row.trace.events.filter(({ kind }) => kind.startsWith('review.'));
  const summary = row.turns[0].result.reviews[0];
  Object.assign(summary, { status: 'skipped', reason: 'no_evidence', model_calls: 0, tool_calls: 0, write_attempts: 0 });
  switch (variant) {
    case 'unknown': case 'capture_timeout': case 'new_input': summary.reason = variant; break;
    case 'missing_counts': delete summary.model_calls; break;
    case 'model': summary.model_calls = 1; break;
    case 'write': summary.write_attempts = 1; break;
    case 'reason_conflict': break;
  }
  Object.assign(row.trace.events[1], summary);
  if (variant === 'reason_conflict') row.trace.events[1].reason = 'evidence_budget';
  const latency = collect(result, annotations()).accounting.latency;
  assert.equal(latency.status, 'blocked'); assert.equal(latency.p50, null); assert.equal(latency.p95, null);
});
