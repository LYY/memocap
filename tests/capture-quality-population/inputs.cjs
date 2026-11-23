const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const mapping = require('./mapping.json');

class PopulationInputError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PopulationInputError';
    this.code = code;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const bytes = readFileSync(path.join(__dirname, '../capture-evaluation/tuning.json'));
if (createHash('sha256').update(bytes).digest('hex') !== mapping.tuning_sha256) {
  throw new PopulationInputError('frozen_tuning_hash_mismatch');
}
function atPointer(value, pointer) {
  return pointer.split('/').slice(1).reduce((node, key) => node[key], value);
}
function adoptionKeys(original) {
  const explicit = Object.hasOwn(original, 'adoption_keys');
  const valid = (condition) => { if (!condition) throw new PopulationInputError('fixture_adoption_invalid'); };
  if (!Object.hasOwn(original, 'record') && !Object.hasOwn(original, 'used')) {
    valid(!explicit); return Object.freeze([]);
  }
  valid(original.record && typeof original.used === 'boolean' &&
    (original.participants === undefined || Array.isArray(original.participants)));
  const records = [original.record, ...(original.participants ?? [])];
  valid(records.length <= 2 && records.every((record) => record && typeof record.key === 'string' && record.key.trim() &&
    typeof record.placement === 'string' && record.placement.trim()) && new Set(records.map((record) => record.key)).size === records.length);
  const keys = explicit ? original.adoption_keys : original.used ? [original.record.key] : [];
  valid(Array.isArray(keys) && keys.every((key) => typeof key === 'string' && records.some((record) => record.key === key)) &&
    new Set(keys).size === keys.length && (original.used ? keys.includes(original.record.key) : keys.length === 0));
  const selected = records.filter((record) => keys.includes(record.key));
  valid(new Set(records.map((record) => record.placement)).size === 1 && selected.every((record) =>
    typeof record.body === 'string' && record.body.trim() && Array.from(record.body).length <= 800));
  return Object.freeze(selected.map((record) => record.key));
}

function createInputs(raw, selectedMapping) {
const tuning = deepFreeze(JSON.parse(raw));
const mapping = deepFreeze(structuredClone(selectedMapping));
function resolveCase(id) {
  const entry = mapping.cases.find((candidate) => candidate.id === id);
  if (!entry) throw new PopulationInputError('unmapped_case');
  const original = atPointer(tuning, entry.pointer);
  if (original.id !== id) throw new PopulationInputError('case_pointer_mismatch');
  return { entry, original, adoption_keys: adoptionKeys(original) };
}

function modelInput(id) {
  const { original, adoption_keys } = resolveCase(id);
  if (original.turns) {
    return structuredClone({ turns: original.turns.map((turn) => ({
      user: turn.user, ...(turn.assistant ? { assistant: turn.assistant } : {}),
    })) });
  }
  const snapshot = ({ key, body, placement }) => ({ key, body, placement });
  return structuredClone({
    request: { origin: mapping.maintenance_request.origin, text: mapping.maintenance_request.text },
    primary: { snapshot: snapshot(original.record), fixture_used: original.used,
      ...(Object.hasOwn(original, 'adoption_keys') ? { role: adoption_keys.includes(original.record.key) ? 'adoption-declared' : 'comparison-only' } : {}) },
    comparisons: (original.participants || []).map((record) => ({ snapshot: snapshot(record),
      role: Object.hasOwn(original, 'adoption_keys') && adoption_keys.includes(record.key) ? 'adoption-declared' : 'comparison-only' })),
  });
}

function payload(id, pointer) {
  return structuredClone(atPointer(resolveCase(id).original, pointer));
}
return Object.freeze({ mapping, tuning, resolveCase, modelInput, payload });
}
module.exports = { ...createInputs(bytes.toString('utf8'), mapping), createInputs, adoptionKeys, deepFreeze, PopulationInputError };
