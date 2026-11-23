const { population: selectedPopulation } = require('./population.cjs');
const { requireStage, hash } = require('./value.cjs');
const { providerBodyLimit } = require('./provider-transport.cjs');
const { executionProfile } = require('./execution-profile.cjs');

function caseInventory(id, input, captureExecutionMs, maintenanceExecutionMs) {
  const profile = executionProfile(input, captureExecutionMs, maintenanceExecutionMs);
  const { entry, original, adoption_keys } = selectedPopulation(input).resolveCase(id);
  const turns = original.turns?.length ?? 1;
  const operations = entry.script.filter(([name]) => name !== 'control').length;
  const controls = entry.script.length - operations;
  const seeds = original.record ? 1 + (original.participants?.length ?? 0) : 0;
  const uses = adoption_keys.length;
  const capture_reviews = entry.stratum === 'recovery-safety' ? 0 : turns;
  const maintenance_reviews = original.used && entry.stratum !== 'recovery-safety' ? 1 : 0;
  const reviews = capture_reviews + maintenance_reviews;
  return { id, stratum: entry.stratum, turns, operations, controls, seeds, uses, reviews, capture_reviews, maintenance_reviews,
    parent_requests: turns + operations + seeds + uses,
    worker_requests: reviews * 3, children: reviews * 2, review_write_attempts: reviews,
    setup_writes: seeds + (entry.stratum === 'snapshot-safety' ? 1 : 0),
    native_reads: seeds * 3 + uses + reviews * 8,
    host_opens: 1, host_closes: 1, seed_calls: seeds,
    carrier_writes: operations * 2, deadline_ms: turns * 30000 + capture_reviews * profile.capture_ms +
      maintenance_reviews * profile.maintenance_ms + reviews * (profile.terminal_pad_ms + profile.outer_pad_ms) + seeds * 30000 + 33000 };
}

function inventory(input, captureExecutionMs, maintenanceExecutionMs) {
  const population = selectedPopulation(input);
  const profile = executionProfile(population, captureExecutionMs, maintenanceExecutionMs);
  const { mapping } = population;
  const cases = mapping.cases.map(({ id }) => caseInventory(id, population, profile.capture_ms, profile.maintenance_ms));
  const totals = Object.fromEntries(Object.keys(cases[0]).filter((key) => typeof cases[0][key] === 'number')
    .map((key) => [key, cases.reduce((sum, row) => sum + row[key], 0)]));
  const limits = derive(totals);
  if (population.descriptor) {
    const ceiling = inventory(undefined, profile.capture_ms, profile.maintenance_ms);
    const caseCeilings = ceiling.cases.map((row) => {
      const extraUses = row.maintenance_reviews ? row.seeds - row.uses : 0;
      return derive({ ...row, uses: row.uses + extraUses, parent_requests: row.parent_requests + extraUses,
        native_reads: row.native_reads + extraUses });
    });
    requireStage(Object.entries(limits).every(([key, value]) => value <= ceiling.limits[key]) &&
      cases.every((row) => Object.entries(derive(row)).filter(([, value]) => typeof value === 'number').every(([key, value]) =>
        value <= Math.max(...caseCeilings.map((original) => original[key])))), 'finite_evaluation_budget');
  }
  return { schema: 2, tuning_sha256: mapping.tuning_sha256, cases, limits, execution_profile: profile,
    ...(population.descriptor ? { evaluation_sha256: hash(population.descriptor), evaluation_id: population.descriptor.id } : {}),
    derivation: { parent_requests: 'one terminal generation per root plus at most one per source/read/use tool; no retries',
      worker_requests: 'three generation dispatch slots per independent workflow, including failed calls',
      reviews: '31 capture slots including negative roots plus 10 independent adopted-maintenance workflows; recovery does not add a semantic opportunity',
      writes: 'one dispatch per observed workflow, 14 seed inserts plus one controlled edit; 28 private database initializations separately counted',
      native_calls: 'setup/review mutations, bounded reads, two initialization calls per host, eight auxiliary metadata calls per root and workflow, four per use',
      native_processes: 'two reserved processes per call plus one verified-Node handshake per isolated host',
      transports: 'SDK and provider generations are separate; provider bridge shares the existing 256 control requests per host and 256KiB per direction; control_bytes includes bridge body bytes, excludes HTTP headers as with JSON control',
      provider_bytes: 'each provider body/stream capped at 262144 bytes; cumulative dimensions each equal provider_requests * 262144; parent precharges once, child only observes local provider meters; identity raw body bytes, excludes TLS/HTTP headers',
      sdk_requests: 'eight host setup/cleanup slots, four per root, each parent generation, 128 per review, four per seed/use',
      deadline_ms: '30 seconds per open/seed/parent turn; selected capture and maintenance execution plus 6 seconds outer collection per review and 3 seconds cleanup; sequential',
      safety: 'enforced finite ceilings only, not authorization, measured usage or evidence of model compatibility' },
    authorization: 'inventory only; not a grant', old_canary_budget_reusable: false };
}

function derive(totals) {
  const sdkRequests = totals.host_opens * 8 + totals.turns * 4 + totals.parent_requests + totals.reviews * 128 + totals.seeds * 4 + totals.uses * 4;
  const calls = totals.setup_writes + totals.native_reads + totals.review_write_attempts + totals.host_opens * 2 + totals.turns * 8 + totals.reviews * 8 + totals.uses * 4;
  return { ...totals, requests: totals.parent_requests + totals.worker_requests, provider_requests: totals.parent_requests + totals.worker_requests,
    provider_request_bytes: (totals.parent_requests + totals.worker_requests) * providerBodyLimit,
    provider_response_bytes: (totals.parent_requests + totals.worker_requests) * providerBodyLimit,
    initialization_writes: totals.host_opens, host_processes: totals.host_opens, control_listeners: totals.host_opens,
    control_requests: totals.host_opens * 256, control_bytes: totals.host_opens * 256 * 262144 * 2,
    part_bytes: 8192, turn_bytes: 32768, review_packet_bytes: 65536, observation_bytes: 131072,
    total_bytes: (totals.parent_requests + totals.worker_requests) * 65536 + totals.operations * 8192 + totals.reviews * 8 * 131072 + sdkRequests * 196608,
    sdk_requests: sdkRequests, sdk_request_bytes: 65536, sdk_response_bytes: 131072,
    native_calls: calls, native_processes: calls * 2 + totals.host_opens,
    child_messages: 16, child_parts: 24, child_message_bytes: 32768 };
}
function caseLimits(id, input, captureExecutionMs, maintenanceExecutionMs) { return derive(caseInventory(id, input, captureExecutionMs, maintenanceExecutionMs)); }

function runLimits(input, parentProfile, captureExecutionMs, maintenanceExecutionMs) {
  requireStage(parentProfile === undefined || parentProfile === null ||
    parentProfile === 'controlled_native_parent_genuine_curator_v1', 'controlled_profile');
  const limits = { ...inventory(input, captureExecutionMs, maintenanceExecutionMs).limits };
  if (parentProfile) {
    const roots = limits.parent_requests;
    Object.assign(limits, { scripted_root_generations: roots, scripted_root_dispatches: roots,
      scripted_root_request_bytes: roots * providerBodyLimit, scripted_root_response_bytes: roots * providerBodyLimit,
      parent_requests: 0, requests: limits.worker_requests, provider_requests: limits.worker_requests,
      provider_request_bytes: limits.worker_requests * providerBodyLimit,
      provider_response_bytes: limits.worker_requests * providerBodyLimit });
  }
  return limits;
}

function createMeter(approval, mode, input, accounting) {
  const profile = executionProfile(input, accounting?.captureExecutionMs, accounting?.maintenanceExecutionMs);
  const needed = inventory(input, profile.capture_ms, profile.maintenance_ms);
  if (mode === 'native') requireStage(executionProfile(undefined, approval?.captureExecutionMs, approval?.maintenanceExecutionMs) === profile, 'capture_execution_profile_mismatch');
  requireStage(approval && approval.mode === mode && ['offline', 'native'].includes(mode), 'separate_approved_budget_required');
  if (mode === 'native') requireStage(approval.approved === true && typeof approval.approval_id === 'string' &&
    (!needed.evaluation_sha256 || approval.evaluation_sha256 === needed.evaluation_sha256) &&
    approval.population_sha256 === needed.tuning_sha256 && approval.inventory_sha256 === hash(needed) &&
    approval.approval_id !== approval.consumed_canary_id, 'separate_approved_budget_required');
  const selected = mode === 'native' && Boolean(needed.evaluation_sha256);
  const freshLimits = Object.freeze(runLimits(input, selected ? accounting?.execution_profile : undefined, profile.capture_ms, profile.maintenance_ms));
  const limits = structuredClone(mode === 'offline' ? needed.limits : approval.limits);
  if (selected) requireStage(limits !== null && typeof limits === 'object' && !Array.isArray(limits) &&
    Object.entries(limits).every(([key, value]) => Object.hasOwn(freshLimits, key) &&
      Number.isSafeInteger(value) && value >= 0 && value <= freshLimits[key]), 'finite_evaluation_budget');
  requireStage(limits && Object.entries(selected ? freshLimits : needed.limits).every(([key, value]) =>
    Number.isSafeInteger(limits[key]) && limits[key] >= value), 'population_budget_insufficient');
  const prior = selected ? structuredClone(accounting?.retained_ledger) : {};
  if (selected) {
    requireStage(prior !== null && typeof prior === 'object' && !Array.isArray(prior), 'invalid_prior_spend');
    const required = ['requests', 'parent_requests', 'provider_requests', 'provider_request_bytes', 'provider_response_bytes'];
    requireStage(Object.keys(prior).every((key) => Object.hasOwn(freshLimits, key) && Number.isSafeInteger(prior[key]) && prior[key] >= 0) &&
      (Object.keys(prior).length === 0 || required.every((key) => Object.hasOwn(prior, key)) &&
        prior.requests === prior.provider_requests && prior.parent_requests + (prior.worker_requests ?? 0) === prior.requests &&
        (prior.requests > 0 || prior.provider_request_bytes === 0 && prior.provider_response_bytes === 0)), 'invalid_prior_spend');
    requireStage(Object.hasOwn(prior, 'worker_requests'), 'controlled_prior_spend');
    requireStage(approval.retained_ledger_sha256 === hash(prior), 'retained_ledger_grant_binding');
    requireStage(Object.entries(prior).every(([key, value]) => Number.isSafeInteger(value + freshLimits[key])), 'invalid_prior_spend');
    if (Object.hasOwn(approval, 'cumulative_limits')) {
      const guard = approval.cumulative_limits;
      requireStage(guard !== null && typeof guard === 'object' && !Array.isArray(guard) && Object.keys(guard).length > 0 &&
        Object.entries(guard).every(([key, value]) => Object.hasOwn(freshLimits, key) &&
          Number.isSafeInteger(value) && value >= 0), 'invalid_cumulative_limits');
      for (const [key, ceiling] of Object.entries(guard)) {
        requireStage((prior[key] ?? 0) + freshLimits[key] <= ceiling, `budget_${key}`);
      }
    }
  }
  const used = {};
  const { maintenanceExecutionMs: declaredMaintenance, ...historicalAccounting } = accounting ?? {};
  const started = Date.now();
  function charge(key, count = 1) {
    requireStage(key === 'host_closes' || Date.now() - started <= (selected ? freshLimits : limits).deadline_ms, 'population_deadline');
    requireStage(Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(selected ? freshLimits[key] : limits[key]), 'unknown_budget_dimension');
    requireStage((used[key] ?? 0) + count <= (selected ? freshLimits[key] : limits[key]), `budget_${key}`);
    used[key] = (used[key] ?? 0) + count;
  }
  return { charge, limits: selected ? freshLimits : limits, mode, inventory_sha256: hash(needed), approval_id: approval.approval_id ?? null,
    ...(selected ? { accounting_sha256: hash({ ...historicalAccounting, captureExecutionMs: profile.capture_ms,
      ...(profile.maintenance_ms === 30000 ? {} : { maintenanceExecutionMs: profile.maintenance_ms }) }), cumulativeSnapshot: () => ({ ...prior,
      ...Object.fromEntries(Object.entries(used).map(([key, value]) => [key, (prior[key] ?? 0) + value])) }) } : {}),
    snapshot: () => structuredClone(used) };
}
module.exports = { inventory, caseInventory, caseLimits, runLimits, createMeter };
