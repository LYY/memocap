const defaultInputs = require('./inputs.cjs');

/** @typedef {'access_denied_terminal'|'unmapped_operation'|'unmapped_arguments'|'partial_disclosure_mismatch'|'duplicate_submission'|'job_not_completed'|'failure_precondition_changed'|'failed_attempt_required'|'approval_marker_missing'|'separate_verifier_required'|'revision_read_required'|'unmapped_approval_count'|'both_approval_probes_required'|'inventory_mismatch'|'retirement_checks_failed'|'concurrent_edit_required'|'unmapped_operation_kind'|'completion_not_mapped'|'job_not_queued'|'control_not_mapped'} BlockCode */
/** @typedef {{kind:'blocked', code:BlockCode} | {kind:'response', transport:'local_mock', value:object} | {kind:'control', event:string}} Result */
/** @param {BlockCode} code @returns {Result} */
const blocked = (code) => ({ kind: 'blocked', code });
/** @param {object} value @returns {Result} */
const response = (value) => ({ kind: 'response', transport: 'local_mock', value });

function createDispatcher(id, inputs = defaultInputs) {
  const { mapping, resolveCase, modelInput, payload } = inputs;
  const { entry } = resolveCase(id);
  const kinds = new Set(Object.values(entry.operations).map((operation) => operation.kind));
  let job = 'idle';
  let failed = false;
  let marker = false;
  let verified = false;
  let denied = false;
  let revision = false;
  const probes = new Map();
  let inventoryChecked = false;
  let valueCompared = false;
  const retirement = mapping.retirement_state;
  let aliasPresent = retirement.alias_present;
  let replacementApproved = retirement.approved;
  let replacements = [...retirement.entries];
  let historicalFacts = [...retirement.primary_historical_facts];
  const replacementFacts = new Set(retirement.replacement_normalized_facts);
  let version = 1;
  const boundVersion = 1;
  let recovery = 'unknown';
  const transcript = [];

  function emit(operation) {
    const raw = payload(id, operation.pointer);
    const toolPointer = operation.pointer.match(/^\/turns\/\d+\/tools\/\d+\/output$/);
    if (toolPointer) {
      const { output, ...rawTool } = payload(id, operation.pointer.slice(0, -7));
      const tool = Object.fromEntries(['tool', 'name', 'path', 'command', 'status', 'input', 'type', 'offset', 'limit']
        .filter((key) => Object.hasOwn(rawTool, key)).map((key) => [key, rawTool[key]]));
      if (tool.input) tool.input = Object.fromEntries(['filePath', 'offset', 'limit', 'command', 'timeout', 'workdir', 'description']
        .filter((key) => Object.hasOwn(tool.input, key)).map((key) => [key, tool.input[key]]));
      return response({ output, tool });
    }
    return response(typeof raw === 'string' ? { output: raw } : { observation: raw });
  }

  function dispatch(name, args = {}) {
    if (denied) return blocked('access_denied_terminal');
    const operation = Object.hasOwn(entry.operations, name) ? entry.operations[name] : undefined;
    if (!operation) return blocked('unmapped_operation');
    if (!args || typeof args !== 'object' || Array.isArray(args)) return blocked('unmapped_arguments');
    const allowed = operation.kind === 'approve' ? ['count']
      : operation.kind === 'partial' ? ['offset', 'full'] : [];
    if (Object.keys(args).some((key) => !allowed.includes(key))) return blocked('unmapped_arguments');
    switch (operation.kind) {
      case 'read': return emit(operation);
      case 'partial':
        if (args.offset !== 10 || args.full !== false) return blocked('partial_disclosure_mismatch');
        return response({ ...emit(operation).value, disclosure: {
          offset: 10, complete: false, opaque_unobserved_padding: [1, 9], carrier_mapping_only: true,
        } });
      case 'submit':
        if (job !== 'idle') return blocked('duplicate_submission');
        job = 'queued';
        return emit(operation);
      case 'status':
        if (job !== 'completed') return blocked('job_not_completed');
        return emit(operation);
      case 'attempt':
        if (marker) return blocked('failure_precondition_changed');
        failed = true;
        return emit(operation);
      case 'repair':
        if (!failed) return blocked('failed_attempt_required');
        marker = true;
        verified = false;
        return emit(operation);
      case 'verify':
        if (!marker) return blocked('approval_marker_missing');
        verified = true;
        return response({ verifier: 'separate-local-marker-check', passed: marker });
      case 'verified-read':
        if (!verified) return blocked('separate_verifier_required');
        return emit(operation);
      case 'revision':
        revision = true;
        return emit(operation);
      case 'approve': {
        if (!revision) return blocked('revision_read_required');
        if (args.count !== 1 && args.count !== 2) return blocked('unmapped_approval_count');
        const accepted = args.count >= 2;
        probes.set(args.count, accepted);
        return response({ count: args.count, accepted });
      }
      case 'approval-check':
        if (probes.get(1) !== false || probes.get(2) !== true) return blocked('both_approval_probes_required');
        return emit(operation);
      case 'inventory':
        inventoryChecked = !aliasPresent && replacementApproved && replacements.length === 1
          && replacements[0] === 'scripts/alpha-v2';
        if (!inventoryChecked) return blocked('inventory_mismatch');
        return emit(operation);
      case 'compare': {
        const oldFacts = [...retirement.primary_normalized_facts, ...historicalFacts];
        const unique = oldFacts.filter((fact) => !replacementFacts.has(fact));
        valueCompared = unique.length === 0;
        return response({ unique_facts: unique, replacement_preserves: [...replacementFacts] });
      }
      case 'retirement-check':
        if (!inventoryChecked || !valueCompared) return blocked('retirement_checks_failed');
        return emit(operation);
      case 'unavailable': return emit(operation);
      case 'denied':
        denied = true;
        return emit(operation);
      case 'conflict-probe':
        if (version === boundVersion) return blocked('concurrent_edit_required');
        return response({ snapshot: 'conflict', applied: false, writes: 0 });
      case 'lost': return emit(operation);
      case 'readback': return response({ outcome: recovery, additional_writes: 0 });
      default: return blocked('unmapped_operation_kind');
    }
  }

  function control(event) {
    if (denied) return blocked('access_denied_terminal');
    switch (event) {
      case 'complete-job':
        if (!kinds.has('status')) return blocked('completion_not_mapped');
        if (job !== 'queued') return blocked('job_not_queued');
        job = 'completed';
        break;
      case 'alias-present':
      case 'replacement-unapproved':
      case 'multiple-replacements':
      case 'wrong-replacement':
      case 'unique-history':
        if (!kinds.has('inventory')) return blocked('control_not_mapped');
        inventoryChecked = false;
        valueCompared = false;
        switch (event) {
          case 'alias-present': aliasPresent = true; break;
          case 'replacement-unapproved': replacementApproved = false; break;
          case 'multiple-replacements': replacements = ['scripts/alpha-v2', 'other']; break;
          case 'wrong-replacement': replacements = ['other']; break;
          case 'unique-history': historicalFacts = ['historical-decision']; break;
          default: return blocked('control_not_mapped');
        }
        break;
      case 'concurrent-edit':
        if (!kinds.has('conflict-probe')) return blocked('control_not_mapped');
        version = 2;
        break;
      case 'readback-matches':
      case 'readback-differs':
      case 'readback-unavailable':
        if (!kinds.has('readback')) return blocked('control_not_mapped');
        recovery = event.slice('readback-'.length);
        break;
      default: return blocked('control_not_mapped');
    }
    const result = { kind: 'control', event };
    transcript.push({ channel: 'test-control-only', event, result });
    return result;
  }

  function execute(name, args) {
    const result = dispatch(name, args);
    transcript.push({ channel: 'model-operation', name, args: structuredClone(args || {}), result });
    return structuredClone(result);
  }

  return Object.freeze({
    execute, control, input: () => modelInput(id),
    model: Object.freeze({ execute, input: () => modelInput(id) }),
    audit: () => structuredClone({ transcript, native_adoptions: 0, native_writes: 0,
      secondary_uses: 0, natural_opportunities_added: 0 }),
  });
}
module.exports = { createDispatcher };
