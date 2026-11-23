const definitions = require('./definitions.cjs');
const { verify, participants, identity, matchesProposal, claimedWrite } = require('./persistence.cjs');
const { captureOutputs, orphanToolOutputs } = require('./outputs.cjs');
const { matchesRawDecision } = require('./maintenance-link.cjs');
const { hash } = definitions;
const terminal = new Set(['no_candidate', 'rejected', 'skipped', 'duplicate', 'saved', 'proposal', 'denied', 'blocked', 'failed', 'keep', 'unknown', 'not_queued', 'reevaluate', 'applied', 'committed']);
function inventory(result, definitions = require('./definitions.cjs')) {
  const state = { cases: [], reviews: [], attempts: [], outputs: [], seeds: [], decisions: [], proposals: [], mutations: [], issues: [], events: [] };
  const actual = result?.cases ?? [];
  const planned = result?.planned_case_ids ?? [];
  if (result && (new Set(planned).size !== planned.length || definitions.cases.some(({ id }) => !planned.includes(id)))) state.issues.push('planned_case_ids:missing_or_duplicate');
  const ids = [...new Set([...definitions.cases.map(({ id }) => id), ...planned, ...actual.map(({ id }) => id)])];
  for (const id of ids) {
    const frozen = definitions.cases.find((row) => row.id === id);
    const matches = actual.filter((row) => row.id === id); const item = matches[0];
    const row = { ...(frozen ?? { id, lane: 'unknown', family: 'unknown', stratum: 'unknown', turns: 0, required_conditions: [], claim_ids: [] }),
      missing: [], complete: false, observed: Boolean(item), runtime: item?.runtime ?? null };
    if (!frozen) row.missing.push('foreign_case');
    if (matches.length !== 1) row.missing.push('case:missing_or_duplicate');
    if (item?.status === 'blocked' || item?.setup_recovery_required) row.missing.push(`case:blocked:${item.reason ?? 'setup_recovery_required'}`);
    if (item && (item.original_sha256 !== frozen?.original_sha256 || item.tuning_sha256 !== definitions.tuning_sha256)) row.missing.push('frozen_case_hash');
    if (item && (!result.completed_case_ids?.includes(id) || !result.attempted_case_ids?.includes(id) ||
      result.unexecuted_case_ids?.includes(id) || result.case_failures?.some((failure) => failure.id === id))) row.missing.push('case:execution_incomplete');
    if (!Array.isArray(item?.trace?.events) || !Array.isArray(item?.trace?.saved_outputs) || !Array.isArray(item?.trace?.writes)) row.missing.push('trace:missing_inventory');
    if (!item?.cleanup?.exited || item.cleanup.children !== 0) row.missing.push('case:cleanup_incomplete');
    const events = (item?.trace?.events ?? []).map((event, index) => ({ ...event, case_id: id, event_index: index }));
    state.events.push(...events);
    state.seeds.push(...(item?.seeds ?? []).map((seed) => ({ case_id: id, ...seed })));
    const turns = item?.turns ?? [];
    for (let turn = 1; turn <= row.turns; turn++) {
      const observed = turns.filter((entry) => entry.turn === turn);
      if (observed.length !== 1) row.missing.push(`turn:${turn}:missing_or_duplicate`);
      else if (observed[0].status !== 'screened_whole_unit' && !observed[0].result?.reviews?.some((review) => terminal.has(review.status))) row.missing.push(`turn:${turn}:missing_terminal`);
    }
    const bindings = new Map();
    const remember = (root, user, lane, turn = null) => {
      const key = JSON.stringify([id, root, user, lane]);
      if (!bindings.has(key)) bindings.set(key, { key, case_id: id, root, user, lane: lane ?? 'unknown', turn,
        family: row.family, stratum: row.stratum, summaries: [], events: [], semantic: false, missing: [] });
      return bindings.get(key);
    };
    for (const turn of turns) for (const summary of turn.result?.reviews ?? []) {
      remember(summary.parentID, summary.user_id, summary.workflow, turn.turn).summaries.push(summary);
    }
    const metadataTool = (event) => !claimedWrite(event) && (['memocap_read', 'memocap_recall', 'memocap_scope'].includes(event.tool) ||
      event.tool === 'memocap_maintain' && event.args?.operation === 'use' && event.receipt?.status === 'used');
    for (const event of events) {
      if (['provider.dispatch', 'provider.finished', 'model.parent.response'].includes(event.kind) || event.kind === 'provider.link' && event.workflow == null) continue;
      if (event.workflow == null && (['memory.read', 'memory.use', 'memory.recall'].includes(event.kind) ||
        event.kind === 'tool.output' && metadataTool(event) || event.kind === 'permission' &&
        (['memocap_read', 'memocap_recall', 'memocap_scope'].includes(event.tool) || events.some((other) =>
          other.kind === 'tool.output' && other.session === event.session && other.message === event.message &&
          other.root === event.root && other.user === event.user && other.tool === event.tool && metadataTool(other))))) continue;
      const review = remember(event.root, event.user, event.workflow);
      review.events.push(event);
      if (event.kind === 'model.response' || event.kind === 'raw') review.semantic = true;
    }
    for (const review of item?.trace?.reviews ?? []) {
      const lanes = review.workflows ? Object.entries(review.workflows).filter(([, workflow]) => workflow.stages?.length).map(([lane]) => lane)
        : [...bindings.values()].filter((entry) => entry.root === review.root && entry.user === review.user).map((entry) => entry.lane);
      for (const lane of lanes) remember(review.root, review.user, lane);
    }
    for (const review of bindings.values()) {
      if (![review.root, review.user].every((value) => typeof value === 'string' && value.trim()) ||
        !['capture', 'maintenance'].includes(review.lane)) review.missing.push('review:binding');
      if (review.summaries.length !== 1 || !terminal.has(review.summaries[0].status)) review.missing.push('review:terminal');
      if (review.turn === null) review.missing.push('review:turn_link');
      if (!review.events.some((event) => event.kind === 'review.started') && review.summaries.some((summary) => summary.model_calls > 0)) review.semantic = true;
      if (review.summaries.some((summary) => ['saved', 'committed'].includes(summary.status)) && !events.some((event) =>
        event.kind === 'native.dispatch' && event.root === review.root && event.user === review.user && event.workflow === review.lane)) review.missing.push('saved_terminal:dispatch_absent');
      if (review.lane === 'maintenance' && (review.summaries.some((summary) => ['proposal', 'applied', 'committed'].includes(summary.status)) ||
        review.events.some((event) => event.kind === 'native.dispatch')) && !review.events.some((event) => event.kind === 'issued')) review.missing.push('issued:inventory_unobserved');
      row.missing.push(...review.missing.map((reason) => `${review.key}:${reason}`));
      state.reviews.push(review);
    }
    const attempts = new Set([...events.filter((event) => event.kind.startsWith('native.')).map((event) => event.attempt),
      ...(item?.trace?.writes ?? []).map((write) => write.attempt), ...(item?.trace?.saved_outputs ?? []).map((output) => output.attempt)]);
    for (const attemptID of attempts) {
      const parts = events.filter((event) => event.attempt === attemptID && event.kind.startsWith('native.'));
      const mirror = item?.trace?.writes?.find((write) => write.attempt === attemptID);
      const base = parts.find((event) => event.kind === 'native.dispatch') ?? parts[0] ?? mirror ?? item?.trace?.saved_outputs?.find((output) => output.attempt === attemptID);
      const attempt = { key: JSON.stringify([id, attemptID]), case_id: id, attempt: attemptID ?? null, lane: base?.workflow ?? 'unknown',
        family: row.family, stratum: row.stratum, root: base?.root, user: base?.user, case_events: events };
      const proof = verify(attempt, parts); delete attempt.case_events;
      if (!attemptID) proof.missing.push('native.attempt_id');
      const boundReview = [...bindings.values()].find((review) => review.root === attempt.root && review.user === attempt.user && review.lane === attempt.lane);
      if (!boundReview || boundReview.missing.length) proof.missing.push('native.review_terminal_link');
      attempt.turn = boundReview?.turn ?? null; Object.assign(attempt, proof, { verified: proof.missing.length === 0 });
      if (attempt.lane === 'capture' || attempt.lane === 'unknown') {
        const outputProof = captureOutputs(attempt, { ...item?.trace, events }, row);
        attempt.missing.push(...outputProof.missing); attempt.verified = attempt.missing.length === 0;
        state.outputs.push(...outputProof.outputs);
      }
      state.attempts.push(attempt);
      if (attempt.lane === 'maintenance' && proof.commit?.receipt?.status === 'ok') state.mutations.push({ key: attempt.key,
        case_id: id, lane: attempt.lane, family: row.family, stratum: row.stratum, verified: attempt.verified,
        participants: participants(proof.dispatch?.request), post: proof.commit.post ?? null, attempt_key: attempt.key });
    }
    for (const event of events.filter((entry) => entry.workflow === 'maintenance')) {
      if (event.kind === 'raw') state.proposals.push({ key: JSON.stringify([id, event.event_index]), case_id: id, lane: 'maintenance',
        family: row.family, stratum: row.stratum, observation: event.observation ?? null });
      if (event.kind !== 'issued') continue;
      const observation = event.observation ?? {}; const proposal = observation.proposal;
      const key = JSON.stringify([id, proposal?.proposal_id ?? `missing:${event.event_index}`]);
      const existing = state.decisions.find((decision) => proposal?.proposal_id ? decision.proposal_id === proposal.proposal_id : decision.key === key);
      if (existing) { existing.observations.push(event); if (existing.case_id !== id || hash(existing.observations[0].observation) !== hash(observation)) existing.missing.push('issued:conflicting_id_or_case'); continue; }
      const decision = { key, case_id: id, lane: 'maintenance', family: row.family, stratum: row.stratum,
        proposal_id: proposal?.proposal_id ?? null, action: proposal?.decision?.action ?? null, observations: [event], missing: [] };
      const fingerprint = proposal ? hash([proposal.decision, proposal.used]) : null;
      const evidence = proposal ? hash(proposal.evidence) : null;
      const task = proposal?.task;
      const binding = { task, parentID: event.root, user_id: event.user, review_id: hash([task, event.user]),
        origin_fingerprint: observation.origin_fingerprint };
      const same = (other) => other.root === event.root && other.user === event.user && other.workflow === event.workflow &&
        Object.entries(binding).every(([field, value]) => hash(other.observation?.[field]) === hash(value)) &&
        [['decision_fingerprint', fingerprint], ['evidence_fingerprint', evidence]].every(([field, value]) =>
          !Object.hasOwn(other.observation ?? {}, field) || other.observation[field] === value);
      const linked = (kind, field) => events.filter((other) => other.kind === kind && same(other) && other.event_index < event.event_index &&
        other.observation?.[field]?.decision_fingerprint === fingerprint && other.observation?.[field]?.evidence_fingerprint === evidence &&
        (kind === 'support' ? other.observation.assessment.status === 'supported' :
          hash(other.observation.used) === hash(proposal.used) && hash(other.observation.validated.decision) === hash(proposal.decision) &&
          hash(other.observation.validated.evidence) === evidence));
      if (!proposal?.proposal_id || proposal.review_status !== 'supported' || !['update', 'merge', 'delete'].includes(decision.action) ||
        observation.decision_fingerprint !== fingerprint || observation.evidence_fingerprint !== evidence ||
        !task || Object.keys(task).length !== 3 || !['parentID', 'taskID', 'epoch'].every((field) => Object.hasOwn(task, field)) ||
        typeof task.taskID !== 'string' || !task.taskID.trim() || !Number.isSafeInteger(task.epoch) || task.epoch < 0 ||
        hash(observation.task) !== hash(task) || task.parentID !== event.root || observation.user_id !== event.user ||
         observation.review_id !== binding.review_id || !same(event) ||
         !Array.isArray(proposal.used) || !proposal.used.length || proposal.used.some((used) => hash(used?.task) !== hash(task))) {
        decision.missing.push('issued:task_fingerprint_support_link');
      } else {
        const raw = events.filter((other) => other.kind === 'raw' && same(other));
        const validated = linked('validated', 'validated');
        const support = linked('support', 'assessment');
        if (raw.length !== 1 || validated.length !== 1 || support.length !== 1 || raw[0].event_index >= validated[0].event_index ||
          validated[0].event_index >= support[0].event_index ||
          !matchesRawDecision(raw[0].observation, proposal, validated[0].observation, support[0].observation.assessment)) {
          decision.missing.push('issued:task_fingerprint_support_link');
        }
      }
      if (!proposal?.target?.participants?.length || proposal.target.database !== proposal.database || proposal.target.operation !== decision.action ||
        !proposal.target.participants.every((target) => proposal.used?.some((used) => identity(used.snapshot) === identity(target) && hash(used.task) === hash(proposal.task)))) decision.missing.push('issued:target_snapshot_link');
      state.decisions.push(decision);
    }
    for (const mutation of state.mutations.filter((entry) => entry.case_id === id)) {
      const attempt = state.attempts.find((entry) => entry.key === mutation.attempt_key);
      const decisions = state.decisions.filter((decision) => decision.case_id === id && matchesProposal(attempt, decision));
      mutation.issued_key = decisions.length === 1 ? decisions[0].key : null;
      mutation.linkage_missing = decisions.length === 1 ? [] : ['mutation:unique_issued_request_link_absent'];
    }
    const orphans = orphanToolOutputs(state, events, row);
    state.outputs.push(...orphans.outputs); state.attempts.push(...orphans.attempts);
    row.complete = row.missing.length === 0; state.cases.push(row);
  }
  if (result?.population_status !== 'complete' && result) state.issues.push('population:incomplete');
  return state;
}
module.exports = { inventory };
