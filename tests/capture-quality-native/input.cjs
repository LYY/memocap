const path = require('node:path');
const { createHash } = require('node:crypto');
const { CanaryBlocked } = require('./entry.cjs');

function carrierPlan(tuning, privateRoot) {
  if (!path.isAbsolute(privateRoot)) throw new CanaryBlocked('private_carrier_root_required');
  const original = tuning.capture.find((entry) => entry.id === 'read-route').turns[0];
  return {
    status: 'prepared_only', source_evidence: null,
    request: { parts: [{ type: 'text', text: original.user }] },
    carrier: { original_locator: original.tools[0].path,
      physical_path: path.join(privateRoot, 'docs/route.md'), bytes: original.tools[0].output,
      mapping: 'private physical carrier only; source contents and request unchanged',
      native_read: 'not_run', normal_root_completion: 'not_run', created: false },
    maintenance: { status: 'blocked', seed_quality_credit: false,
      reason: 'no_original_native_request_or_actual_independent_verification',
      setup: 'separately charged seed with exact key/id/placement/read-receipt mapping required',
      stages: ['raw_proposal', 'validated_decision', 'support_assessment', 'issuance'],
      actual_proposal_permission_transaction_readback: 'not_run' },
  };
}

function supportInputs(contract, selectedSources) {
  return contract.counterfactuals.map((challenge) => {
    const names = challenge.candidate.statements.flatMap((statement) => statement.citations);
    const found = names.every((name) => {
      const binding = contract.bindings[name];
      return selectedSources.some((source) => source.complete === true
        && source.content_hash === binding.content_hash && typeof source.text === 'string'
        && createHash('sha256').update(source.text).digest('hex') === binding.content_hash
        && [...source.text].slice(binding.span.start, binding.span.end).join('') === binding.quote);
    });
    return { name: challenge.name, stratum: 'injected_first_stage_support_only',
      status: found ? 'blocked' : 'seam_not_reached', candidate: null,
      reason: found ? 'actual_native_task_and_selected_bundle_required' : 'actual_selected_source_unavailable',
      injected_first_stage: 'pending', support_prompt: 'production_unchanged', native_completion: null,
      support_dispatches: 0, writes: 0, quality_credit: false };
  });
}

module.exports = { carrierPlan, supportInputs };
