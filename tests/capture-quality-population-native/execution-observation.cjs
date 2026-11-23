function captureObservation(workflows, record, review) {
  const owner = (event) => ({ root: event.parentID, user: event.user_id, workflow: 'capture' });
  return {
    onTimer(event) {
      if (event.phase === 'execution.armed') workflows.start(owner(event), 'capture', event.execution_profile.capture_ms);
      record(event.phase, event, owner(event));
    },
    onLifecycle: (event) => record(event.phase, event, owner(event)),
    onDecision(event) {
      const stage = { raw_proposal: 'raw', admission: 'validated', support_raw: 'support.raw',
        support_acceptance: 'support', identity: 'identity', issuance: 'issued' }[event.stage];
      if (stage) record(stage, { observation: event }, owner(event));
    },
    onReview: (event) => review?.({ ...event, workflow: 'capture' }),
  };
}
module.exports = { captureObservation };
