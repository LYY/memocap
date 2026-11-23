const { createHash } = require('node:crypto');
const tuning = require('../capture-evaluation/tuning.json');
const mapping = require('../capture-quality-population/mapping.json');
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function population() {
  const cases = mapping.cases.map((entry) => {
    const original = [...tuning.capture, ...tuning.maintenance].find(({ id }) => id === entry.id);
    const turns = Array.from({ length: original.turns?.length ?? 1 }, (_, index) => ({ turn: index + 1,
      result: { reviews: [{ parentID: entry.id, user_id: `u${index + 1}`, workflow: 'capture', status: 'no_candidate' }] } }));
    return { ...entry, original_sha256: hash(original), tuning_sha256: mapping.tuning_sha256,
      surface: 'fake-host-wiring-only', runtime: 'NOT_RUN', status: 'wired', seeds: [], turns,
      custody: [], trace: { events: [], writes: [], saved_outputs: [], reviews: turns.map(({ turn }) => ({ root: entry.id,
        user: `u${turn}`, stages: [], missing: ['native.dispatch', 'native.commit', 'native.readback'] })) },
      cleanup: { exited: true, children: 0 }, budget_used: {} };
  });
  const ids = cases.map(({ id }) => id);
  return { kind: 'full_population_native_runtime', population_status: 'complete', planned_case_ids: ids,
    attempted_case_ids: ids, completed_case_ids: ids, unexecuted_case_ids: [], cases, case_failures: [], budget_used: {} };
}
function save(result, id, turn = 1) {
  const item = result.cases.find((row) => row.id === id);
  const attempt = `${id}-${turn}`;
  const binding = { root: id, user: `u${turn}`, workflow: 'capture' };
  const record = { id: turn, placement: 'repository:synthetic', content: 'Synthetic qualified record.',
    content_hash: hash('Synthetic qualified record.'), tags_hash: hash(''), completeness: 'full' };
  const dispatch = { ...binding, kind: 'native.dispatch', attempt, session: 'child', message: `m${turn}`,
    tool: 'memocap_remember', permission: 'resolved', request: null, database: 'synthetic' };
  const receipt = { operation: 'remember', operation_id: `commit-${attempt}`, status: 'inserted', error_present: false,
    records: [record], returned_ids: [record.id] };
  item.trace.events.push({ ...binding, kind: 'permission', session: dispatch.session, message: dispatch.message,
    tool: dispatch.tool, outcome: 'resolved' }, { ...binding, kind: 'consume', session: dispatch.session, message: dispatch.message },
  dispatch, { ...binding, kind: 'native.commit', attempt, receipt }, { ...binding, kind: 'native.readback', attempt,
    receipt: { ...receipt, operation: 'read', operation_id: `read-${attempt}`, status: 'ok', error_code: null, truncated: false } });
  item.trace.writes.push({ ...dispatch, status: 'verified', receipt });
  item.trace.saved_outputs.push({ ...binding, attempt, record, verified: true, origin: 'observed-native-output' });
  item.turns[turn - 1].result.reviews[0].status = 'saved';
  return item;
}
function annotations() {
  return { adjudicators: [{ id: 'reviewer', role: 'independent', provenance: 'Synthetic test adjudicator; no quality claim.' }],
    outputs: [], decisions: [], proposals: [], reviews: [], mutations: [] };
}
const judged = (key) => ({ key, adjudicator: 'reviewer', rationale: 'Synthetic independently supplied judgment.', resolution: 'agreed' });
function outputJudgment(row, gold = []) {
  return { ...judged(row.key), segmentation_complete: true, context: 'valid', durability: 'durable',
    claims: (gold.length ? gold : [null]).map((index, order) => ({ id: `claim-${order}`, text: `Synthetic claim ${order}`,
      support: 'supported', gold_claim: index, rationale: 'Synthetic source comparison.' })),
    conditions: row.required_conditions.map((id) => ({ id, preserved: true, rationale: 'Synthetic qualifier comparison.' })) };
}
module.exports = { population, save, annotations, judged, outputJudgment, hash };
