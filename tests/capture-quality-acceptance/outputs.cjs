const { hash } = require('./definitions.cjs');
const { identity, sameRecord, matchesTool, claimedWrite } = require('./persistence.cjs');

function captureOutputs(attempt, trace, item) {
  const committed = attempt.commit?.receipt;
  const candidates = [];
  for (const [index, output] of (trace.saved_outputs ?? []).entries()) if (output.attempt === attempt.attempt) {
    candidates.push({ record: output.record, origin: 'saved_outputs', index, operation_id: committed?.operation_id,
      bound: output.root === attempt.root && output.user === attempt.user &&
        (!Object.hasOwn(output, 'workflow') || output.workflow === attempt.lane) });
  }
  for (const event of trace.events.filter((event) => event.kind === 'native.commit' && event.attempt === attempt.attempt)) {
    for (const [index, record] of (event.receipt?.records ?? []).entries()) candidates.push({ record, origin: 'native.commit',
      index: [event.event_index, index], operation_id: event.receipt.operation_id,
      bound: event.root === attempt.root && event.user === attempt.user && event.workflow === attempt.lane });
  }
  for (const [index, write] of (trace.writes ?? []).entries()) if (write.attempt === attempt.attempt) {
    for (const [recordIndex, record] of (write.receipt?.records ?? []).entries()) candidates.push({ record, origin: 'writes',
      index: [index, recordIndex], operation_id: write.receipt.operation_id, bound: write.root === attempt.root && write.user === attempt.user &&
        write.workflow === attempt.lane && write.receipt.operation === committed?.operation && write.receipt.status === committed?.status });
  }
  for (const event of trace.events.filter((event) => claimedWrite(event) && event.session === attempt.dispatch?.session && event.message === attempt.dispatch?.message)) {
    for (const [index, entry] of (event.receipt?.results ?? []).entries()) if (entry.memory) {
      const record = { ...entry.memory, content_hash: hash(entry.memory.content), tags_hash: hash(entry.memory.tags ?? ''), completeness: entry.completeness };
      candidates.push({ record, origin: 'tool.output', index: [event.event_index, index], operation_id: event.receipt.operation_id, bound: matchesTool(attempt, event) });
    }
  }
  const outputs = []; const missing = [];
  for (const candidate of candidates) {
    const signature = JSON.stringify([identity(candidate.record), candidate.record?.content, candidate.record?.content_hash,
      candidate.record?.tags_hash, candidate.operation_id]);
    const mirrors = outputs.filter((output) => output.signature === signature);
    const duplicate = mirrors.some((output) => output.sources.some((source) => source.origin === candidate.origin));
    const reasons = [];
    if (!candidate.bound || candidate.operation_id !== committed?.operation_id || committed?.records?.length !== 1 ||
      !sameRecord(candidate.record, committed.records[0])) reasons.push('output:commit_readback_join');
    if (duplicate) reasons.push('output:duplicate_source');
    const source = { origin: candidate.origin, index: candidate.index, operation_id: candidate.operation_id ?? null, missing: reasons };
    const existing = mirrors.find((output) => !duplicate && !reasons.length && !output.missing.length);
    if (existing) existing.sources.push(source);
    else outputs.push({ key: JSON.stringify([attempt.case_id, attempt.attempt, signature, candidate.origin, candidate.index]), signature,
      case_id: attempt.case_id, lane: attempt.lane, family: item.family, stratum: item.stratum, turn: attempt.turn,
      attempt_key: attempt.key, record: candidate.record, required_conditions: item.required_conditions.map((condition) => condition.id),
      origin: candidate.origin, sources: [source], missing: reasons });
    missing.push(...reasons.map((reason) => `${reason}:${candidate.origin}:${JSON.stringify(candidate.index)}`));
  }
  return { outputs: outputs.map((output) => ({ ...output, verified: attempt.verified && !missing.length })), missing };
}

function orphanToolOutputs(state, events, item) {
  const attempts = []; const outputs = [];
  for (const event of events.filter(claimedWrite)) {
    if (state.attempts.some((attempt) => attempt.case_id === item.id && attempt.dispatch?.session === event.session && attempt.dispatch?.message === event.message)) continue;
    const key = JSON.stringify([item.id, 'orphan_tool_output', event.event_index]);
    const lane = event.workflow === 'maintenance' || event.tool === 'memocap_maintain' ? 'maintenance' : 'capture';
    attempts.push({ key, case_id: item.id, lane, family: item.family, stratum: item.stratum, attempt: null,
      verified: false, missing: ['tool.output:unjoined_native_receipt'], dispatch: null, commit: null, readback: null, tool_output: event });
    const review = state.reviews.find((entry) => entry.case_id === item.id && entry.root === event.root && entry.user === event.user && entry.lane === lane);
    if (lane === 'capture') for (const [index, entry] of (event.receipt?.results ?? []).entries()) if (entry.memory) {
      outputs.push({ key: JSON.stringify([key, index]), case_id: item.id, lane, family: item.family, stratum: item.stratum,
        turn: review?.turn ?? null, record: { ...entry.memory, content_hash: hash(entry.memory.content), tags_hash: hash(entry.memory.tags ?? ''), completeness: entry.completeness },
        verified: false, origin: 'orphan_tool_output', attempt_key: key, required_conditions: item.required_conditions.map((condition) => condition.id) });
    }
  }
  return { attempts, outputs };
}

module.exports = { captureOutputs, orphanToolOutputs };
