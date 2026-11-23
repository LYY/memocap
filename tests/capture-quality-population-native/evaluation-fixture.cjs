const { createHash } = require('node:crypto');
const digest = (text) => createHash('sha256').update(text).digest('hex');
function toy() {
  const raw = JSON.stringify({ capture: [{ id: 'toy-read', gold: { sealed: 'gold-only' },
    turns: [{ user: 'Read the disposable toy note.', tools: [{ id: 'toy-tool', name: 'read',
      input: { filePath: '/toy/note.md' }, status: 'completed', output: 'Toy observation.', evaluator: 'sealed-tool-control' }] }] }],
    maintenance: [{ id: 'toy-update', record: { key: 'toy-key', body: 'Toy primary.', placement: 'repository:toy' },
      used: true, authorization: ['update:toy-key'], evaluator: 'sealed-control' }] });
  const mapping = { schema: 1, tuning_sha256: digest(raw), maintenance_request: { origin: 'toy-adapter', text: 'Review the toy snapshot.' },
    retirement_state: { alias_present: false, approved: false, entries: [], primary_historical_facts: [],
      primary_normalized_facts: [], replacement_normalized_facts: [] }, cases: [
      { id: 'toy-read', pointer: '/capture/0', stratum: 'natural', operations: {
        source: { kind: 'read', pointer: '/turns/0/tools/0/output' } }, script: [['source']] },
      { id: 'toy-update', pointer: '/maintenance/0', stratum: 'natural', operations: {}, script: [] },
    ] };
  return { id: 'disposable-unscored-toy', input_utf8: raw, input_sha256: digest(raw), mapping,
    mapping_sha256: digest(JSON.stringify(mapping)) };
}
module.exports = { toy, digest };
