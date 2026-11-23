const { createHash } = require('node:crypto');
const { createInputs, deepFreeze } = require('../capture-quality-population/inputs.cjs');
const { createDispatcher } = require('../capture-quality-population/dispatcher.cjs');
const { requireStage } = require('./value.cjs');
const { captureExecutionProfile } = require('../../plugin/capture/execution-profile.js');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const scalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const kinds = new Set(['read', 'partial', 'submit', 'status', 'attempt', 'repair', 'verify', 'verified-read',
  'revision', 'approve', 'approval-check', 'inventory', 'compare', 'retirement-check', 'unavailable', 'denied',
  'conflict-probe', 'lost', 'readback']);

function freezeDescriptor(input) {
  requireStage(input && typeof input.id === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(input.id) &&
    typeof input.input_utf8 === 'string' && input.input_sha256 === sha256(input.input_utf8) &&
    input.mapping && input.mapping_sha256 === sha256(JSON.stringify(input.mapping)) &&
    input.mapping.tuning_sha256 === input.input_sha256, 'evaluation_digest_mismatch');
  captureExecutionProfile(input.captureExecutionMs, input.maintenanceExecutionMs);
  return deepFreeze(structuredClone({ kind: 'finite-evaluation-v1', id: input.id,
    input_utf8: input.input_utf8, input_sha256: input.input_sha256,
    mapping: input.mapping, mapping_sha256: input.mapping_sha256,
    ...(input.captureExecutionMs === undefined ? {} : { captureExecutionMs: input.captureExecutionMs }),
    ...(input.maintenanceExecutionMs === undefined ? {} : { maintenanceExecutionMs: input.maintenanceExecutionMs }) }));
}
function createEvaluation(input) { return compileEvaluation(input).descriptor; }
function compileEvaluation(input) {
  const descriptor = freezeDescriptor(input);
  const inputs = createInputs(descriptor.input_utf8, descriptor.mapping);
  const { mapping, tuning } = inputs;
  requireStage(typeof mapping.maintenance_request?.text === 'string' && typeof mapping.maintenance_request.origin === 'string' &&
    mapping.retirement_state && ['entries', 'primary_historical_facts', 'primary_normalized_facts', 'replacement_normalized_facts']
      .every((key) => Array.isArray(mapping.retirement_state[key]) && mapping.retirement_state[key].every((value) => typeof value === 'string')),
  'evaluation_mapping_shape');
  requireStage(Array.isArray(mapping.cases) && mapping.cases.length > 0 && mapping.cases.length <= 28 &&
    new Set(mapping.cases.map(({ id }) => id)).size === mapping.cases.length &&
    Array.isArray(tuning.capture) && Array.isArray(tuning.maintenance) &&
    tuning.capture.length + tuning.maintenance.length === mapping.cases.length, 'finite_evaluation_cases');
  const pointers = new Set();
  for (const entry of mapping.cases) {
    requireStage(/^\/(capture|maintenance)\/\d+$/.test(entry.pointer) && !pointers.has(entry.pointer), 'evaluation_case_pointer');
    pointers.add(entry.pointer);
    const { original } = inputs.resolveCase(entry.id);
    requireStage(Array.isArray(entry.script) && entry.script.length <= 16 && entry.operations &&
      ['natural', 'adoption-safety', 'snapshot-safety', 'recovery-safety'].includes(entry.stratum), 'finite_evaluation_script');
    requireStage(original.turns ? original.turns.length > 0 && original.turns.length <= 3 &&
      original.turns.every((turn) => typeof turn.user === 'string' && (turn.assistant === undefined || typeof turn.assistant === 'string') &&
        Array.isArray(turn.tools) && turn.tools.length <= 4 && turn.tools.every((tool) =>
          ['id', 'name', 'path', 'command', 'status', 'type', 'offset', 'limit'].every((key) => tool[key] === undefined || scalar(tool[key])) &&
          (!tool.input || Object.entries(tool.input).filter(([key]) =>
            ['filePath', 'offset', 'limit', 'command', 'timeout', 'workdir', 'description'].includes(key)).every(([, value]) => scalar(value))))) :
      original.record && (original.participants?.length ?? 0) <= 1 && [original.record, ...(original.participants ?? [])]
        .every((record) => ['key', 'body', 'placement'].every((key) => typeof record[key] === 'string')),
    'finite_evaluation_case');
    for (const operation of Object.values(entry.operations)) {
      requireStage(kinds.has(operation.kind), 'evaluation_operation_kind');
      if (operation.pointer !== undefined) {
        requireStage(/^\/turns\/\d+\/tools\/\d+\/output$/.test(operation.pointer) ||
          /^\/observations\/\d+\/(before|after|text|outcome)$/.test(operation.pointer) ||
          /^\/observations\/\d+$/.test(operation.pointer), 'evaluation_source_pointer');
        const value = inputs.payload(entry.id, operation.pointer);
        requireStage(typeof value === 'string' || value && typeof value === 'object' &&
          Object.entries(value).every(([key, item]) => ['outcome', 'status', 'path', 'url'].includes(key) && scalar(item)), 'evaluation_source_payload');
      }
    }
    requireStage(entry.script.every((step) => Array.isArray(step) &&
      (step[0] === 'control' || Object.hasOwn(entry.operations, step[0]))), 'finite_evaluation_script');
  }
  return Object.freeze({ ...inputs, descriptor, frozen: true, createDispatcher: (id) => createDispatcher(id, inputs) });
}
module.exports = { createEvaluation, compileEvaluation };
