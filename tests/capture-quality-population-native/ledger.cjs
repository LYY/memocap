const { matchesReadback } = require('../capture-quality-native/projection.cjs');
const { requireStage, hash, size, identifier } = require('./value.cjs');

function createLedger(meter) {
  const events = [];
  const reviews = new Map();
  const writes = new Map();
  const saved = [];
  function begin(root, user) {
    const key = `${root}/${user}`;
    requireStage(!reviews.has(key), 'review_replayed');
    reviews.set(key, { root, user, stages: [], writes: 0, workflow_writes: {} });
    return key;
  }
  function record(event) {
    requireStage(event && typeof event.kind === 'string' && size(event) <= 131072, 'stage_bytes_or_shape');
    meter.charge('total_bytes', size(event));
    const review = reviews.get(`${event.root}/${event.user}`);
    requireStage(review, 'stage_root_user_mismatch');
    if (event.kind === 'native.dispatch') {
      requireStage([...writes.values()].every((write) => write.status === 'verified'), 'unknown_write_blocks_followup');
      const workflow = event.workflow ?? 'capture';
      requireStage(['capture', 'maintenance'].includes(workflow) && !review.workflow_writes[workflow] &&
        identifier(event.attempt) && !writes.has(event.attempt), 'write_replay');
      requireStage(events.some((prior) => prior.kind === 'permission' && prior.outcome === 'resolved' &&
        prior.root === event.root && prior.user === event.user && prior.session === event.session &&
        prior.message === event.message && prior.tool === event.tool) && event.permission === 'resolved', 'write_without_native_permission');
      meter.charge('review_write_attempts');
      review.writes++;
      review.workflow_writes[workflow] = 1;
      writes.set(event.attempt, { ...event, status: 'unknown' });
    }
    if (event.kind === 'native.commit') {
      const write = writes.get(event.attempt);
      requireStage(write && write.root === event.root && write.user === event.user && write.status === 'unknown', 'unbound_native_commit');
      requireStage(identifier(event.receipt?.operation_id), 'native_receipt_missing');
      write.receipt = structuredClone(event.receipt);
      write.status = 'awaiting_readback';
      for (const record of [...(event.receipt.records ?? []), ...(event.post?.records ?? [])]) saved.push({ root: event.root, user: event.user,
        attempt: event.attempt, origin: 'observed-native-output', record: structuredClone(record), verified: false });
    }
    if (event.kind === 'native.readback') {
      const write = writes.get(event.attempt);
      requireStage(write && write.root === event.root && write.user === event.user, 'unbound_readback');
      if (!write.receipt) {
        review.stages.push('recovery.readback');
        events.push(structuredClone({ ...event, kind: 'recovery.readback', write_outcome: 'unknown' }));
        return;
      }
      requireStage(event.receipt?.operation_id !== write.receipt.operation_id, 'readback_not_independent');
      if (write.receipt.operation === 'remember') {
        requireStage(write.receipt.records.length === 1 && matchesReadback(event.receipt, write.receipt.records[0]), 'readback_identity_or_bytes');
      } else {
        requireStage(event?.organization && write.request && event.organization.database === write.database &&
          event.receipt?.status === 'ok' && event.receipt.error_present === false, 'maintenance_readback_missing');
        const expected = new Map([...(write.post?.records ?? []).map((snapshot) => [`${snapshot.placement}/${snapshot.id}`, snapshot]),
          ...(write.post?.deleted ?? []).map((snapshot) => [`${snapshot.placement}/${snapshot.id}`, null]),
          ...(write.request.dependencies ?? []).map((snapshot) => [`${snapshot.placement}/${snapshot.id}`, snapshot])]);
        requireStage(expected.size > 0 && event.organization.records?.length === expected.size && event.organization.records.every((row) =>
          expected.has(`${row.placement}/${row.id}`) && hash(row.snapshot) === hash(expected.get(`${row.placement}/${row.id}`))), 'maintenance_readback_mismatch');
      }
      write.status = 'verified';
      for (const output of saved.filter((row) => row.attempt === event.attempt)) output.verified = true;
    }
    if (event.kind === 'native.commit' && event.post) {
      const write = writes.get(event.attempt); write.post = structuredClone(event.post);
    }
    review.stages.push(event.kind);
    events.push(structuredClone(event));
  }
  function snapshot() {
    return { events: structuredClone(events), saved_outputs: structuredClone(saved),
      writes: structuredClone([...writes.values()]), recovery_required: [...writes.values()].some((write) => write.status !== 'verified'),
      reviews: [...reviews.values()].map((review) => {
        const workflows = Object.fromEntries(['capture', 'maintenance'].map((workflow) => {
          const actual = events.filter((event) => event.root === review.root && event.user === review.user && event.workflow === workflow);
          const stages = actual.map((event) => event.kind);
          const missing = ['raw', 'validated', 'support', ...(workflow === 'capture' ? ['identity'] : []), 'issued',
            'permission', 'consume', 'native.dispatch', 'native.commit', 'native.readback'].filter((stage) => !stages.includes(stage));
          return [workflow, { stages, missing, raw_count: stages.filter((stage) => stage === 'raw').length,
            accepted_count: actual.filter((event) => event.kind === 'validated' && event.observation?.accepted?.status === 'candidate').length,
            supported_count: actual.filter((event) => event.kind === 'support' && event.observation?.accepted?.status === 'supported').length,
            issued_count: stages.filter((stage) => stage === 'issued').length,
            trace_status: missing.length ? 'blocked_missing_observation' : 'observed_pending_adjudication' }];
        }));
        const missing = ['raw', 'validated', 'support', 'issued', 'permission', 'consume', 'native.dispatch', 'native.commit', 'native.readback']
          .filter((stage) => !review.stages.includes(stage));
        return { ...review, workflows, trace_status: Object.values(workflows).some((value) => value.trace_status === 'observed_pending_adjudication')
          ? 'observed_pending_adjudication' : 'blocked_missing_observation', missing };
      }) };
  }
  return { begin, record, snapshot };
}
module.exports = { createLedger };
