const { collect } = require('./index.cjs');
const { population: examples, save, annotations, outputJudgment, hash } = require('./examples.cjs');
const { createEvaluation } = require('../capture-quality-population-native/population.cjs');
const { toy, digest } = require('../capture-quality-population-native/evaluation-fixture.cjs');

function partialRun() {
  const input = toy(); const raw = JSON.parse(input.input_utf8);
  const original = raw.capture[0];
  original.family = 'bounded-partial-route';
  original.gold = { action: 'save', claims: [
    'For imported offline sketches, use Sketch > Import, preserve point order and gaps, excluding live stylus input.',
  ], conditions: ['Imported offline applicability', 'Sketch > Import entry', 'Live stylus exclusion',
    'Point ordering', 'Gap preservation'], forbidden: 'Only one complete record entails the conjunction; no union of partial records.' };
  original.turns = [
    { user: 'Find the offline import entry.', tools: [{ id: 'entry', name: 'read', status: 'completed',
      input: { filePath: '/toy/import.md' }, output: 'Imported offline sketches use Sketch > Import. Excludes live stylus input.' }] },
    { user: 'Keep the same bounded entry route.', tools: [] },
    { user: 'Verify point ordering and gaps.', tools: [{ id: 'verify', name: 'read', status: 'completed',
      input: { filePath: '/toy/verified.md' }, output: original.gold.claims[0] }] },
  ];
  raw.maintenance = []; input.mapping.cases = input.mapping.cases.slice(0, 1);
  input.input_utf8 = JSON.stringify(raw); input.input_sha256 = digest(input.input_utf8);
  input.mapping.tuning_sha256 = input.input_sha256; input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  const descriptor = createEvaluation(input);
  const result = examples(); const template = structuredClone(result.cases[0]);
  template.id = original.id; template.original_sha256 = hash(original); template.tuning_sha256 = descriptor.input_sha256;
  template.turns = original.turns.map((_, index) => ({ turn: index + 1, result: { reviews: [
    { parentID: original.id, user_id: `u${index + 1}`, workflow: 'capture', status: 'no_candidate' },
  ] } }));
  template.trace.reviews = [];
  result.cases = [template];
  result.planned_case_ids = result.completed_case_ids = result.attempted_case_ids = [original.id];
  result.evaluation = { id: descriptor.id, input_sha256: descriptor.input_sha256,
    mapping_sha256: descriptor.mapping_sha256, evaluation_sha256: hash(descriptor) };
  const facts = ['Subject is imported sketches.', 'Applies offline.', 'Entry is Sketch > Import.',
    'Excludes live stylus input.', 'Ordering and gaps remain unasserted.'];
  for (const turn of [1, 2]) {
    const item = save(result, original.id, turn); const record = item.trace.saved_outputs.at(-1).record;
    record.content = facts.join(' '); record.content_hash = hash(record.content);
  }
  const labels = annotations();
  labels.outputs = collect(result, labels, descriptor).inventory.outputs.map((row) => {
    const label = outputJudgment(row);
    label.claims = facts.map((text, index) => ({ id: `fact-${index}`, text, support: 'supported',
      gold_claim: null, rationale: 'Compared against the early source and explicitly bounded saved body.' }));
    label.conditions = label.conditions.map((condition, index) => index < 3 ? condition : { ...condition,
      preserved: false, admission_omission: { status: 'bounded_partial',
        rationale: 'Unasserted remainder; the saved entry retains its applicability and exclusion.' } });
    label.case_rule = { status: 'satisfied', rationale: 'Bounded entry only; no ordering or gap claim and no full-coverage claim.' };
    return label;
  });
  return { result, labels, descriptor };
}
module.exports = { partialRun };
