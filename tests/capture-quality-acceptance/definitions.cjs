const { createHash } = require('node:crypto');
const tuning = require('../capture-evaluation/tuning.json');
const mapping = require('../capture-quality-population/mapping.json');
const scoring = require('./scoring.json');
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined').digest('hex');
function selectDefinitions(evaluation) {
  const selected = evaluation === undefined ? { mapping, resolveCase(id) {
    const entry = mapping.cases.find((row) => row.id === id);
    return { original: tuning[entry.pointer.split('/')[1]].find((row) => row.id === id) };
  } } : require('../capture-quality-population-native/population.cjs').population(evaluation);
  const cases = selected.mapping.cases.map((entry) => {
    const lane = entry.pointer.split('/')[1];
    const { original } = selected.resolveCase(entry.id); const gold = original.gold ?? {};
    const conditions = gold.conditions ?? (gold.action === 'save' ? gold.claims ?? [] : []);
    return { id: entry.id, family: original.family, lane, stratum: entry.stratum, pointer: entry.pointer,
      original_sha256: hash(original), turns: original.turns?.length ?? 1, gold,
      eligibility_known: typeof gold.action === 'string' && (lane === 'maintenance'
        ? Number.isSafeInteger(gold.mutations) && gold.mutations >= 0 || gold.action === 'read_before_retry' && gold.additional_writes === 0
        : gold.action !== 'save' || Array.isArray(gold.claims)),
      required_conditions: conditions.map((text, index) => ({ id: `${entry.id}:condition:${index}`, text })),
      claim_ids: gold.action === 'save' ? (gold.claims ?? []).map((text, index) => ({ id: `${entry.id}:claim:${index}`, text })) : [] };
  });
  const descriptor = selected.descriptor;
  return { cases, hash, tuning_sha256: selected.mapping.tuning_sha256, scoring,
    evaluation: descriptor ? { id: descriptor.id, input_sha256: descriptor.input_sha256,
      mapping_sha256: descriptor.mapping_sha256, evaluation_sha256: hash(descriptor) } : null };
}
function bindResult(result, selected) {
  if (!(selected.evaluation ? result == null || hash(result.evaluation) === hash(selected.evaluation) : result?.evaluation == null)) {
    require('../capture-quality-population-native/value.cjs').requireStage(false, 'evaluation_result_identity');
  }
}
module.exports = { ...selectDefinitions(), selectDefinitions, bindResult };
