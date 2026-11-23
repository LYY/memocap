const assert = require('node:assert/strict');
const test = require('node:test');
const { createInputs, adoptionKeys } = require('../capture-quality-population/inputs.cjs');
const { caseLimits } = require('./inventory.cjs');
const { toy, digest } = require('./evaluation-fixture.cjs');
const { createEvaluation } = require('./population.cjs');

const primary = { key: 'first', body: 'Primary.', placement: 'repository:toy' };
const comparison = { key: 'second', body: 'Comparison.', placement: primary.placement };
const original = () => ({ record: primary, participants: [comparison], used: true });
test('explicit adoption normalizes order and freezes without changing original bytes', () => {
  const raw = JSON.stringify({ cases: [{ id: 'pair', ...original(), adoption_keys: ['second', 'first'] }] });
  const inputs = createInputs(raw, { maintenance_request: { origin: 'test', text: 'Review.' }, cases: [{ id: 'pair', pointer: '/cases/0' }] });
  const resolved = inputs.resolveCase('pair');
  assert.deepEqual(resolved.adoption_keys, ['first', 'second']);
  assert.equal(Object.isFrozen(resolved.adoption_keys), true);
  assert.equal(JSON.stringify(inputs.tuning), raw);
  assert.equal(digest(JSON.stringify(resolved.original)), digest(JSON.stringify(JSON.parse(raw).cases[0])));
  assert.equal(inputs.modelInput('pair').comparisons[0].role, 'adoption-declared');
});
test('legacy used flag remains primary-only and capture has no adoption', () => {
  assert.deepEqual(adoptionKeys(original()), ['first']);
  assert.deepEqual(adoptionKeys({ ...original(), used: false }), []);
  assert.deepEqual(adoptionKeys({ turns: [{ user: 'Capture.' }] }), []);
  assert.deepEqual(adoptionKeys({ ...original(), used: false, adoption_keys: [] }), []);
});
const invalid = [
  { adoption_keys: null }, { adoption_keys: 'first' }, { adoption_keys: ['first', 2] },
  { adoption_keys: ['first', 'first'] }, { adoption_keys: ['foreign'] }, { adoption_keys: ['second'] },
  { adoption_keys: [] }, { used: false, adoption_keys: ['first'] },
  { participants: [{ ...comparison, key: 'first' }] }, { record: { ...primary, key: '' } },
  { participants: [comparison, { ...comparison, key: 'third' }] },
  { record: { ...primary, body: '' } }, { record: { ...primary, body: ' '.repeat(2) } },
  { record: { ...primary, body: '😀'.repeat(801) } },
  { participants: [{ ...comparison, placement: 'universal' }], adoption_keys: ['first', 'second'] },
];
for (const [index, change] of invalid.entries()) test(`malformed adoption boundary ${index} fails closed`, () => {
  assert.throws(() => adoptionKeys({ ...original(), ...change }), { code: 'fixture_adoption_invalid' });
});
test('capture cannot declare adoption and Unicode limit counts codepoints', () => {
  assert.throws(() => adoptionKeys({ turns: [], adoption_keys: [] }), { code: 'fixture_adoption_invalid' });
  assert.deepEqual(adoptionKeys({ ...original(), record: { ...primary, body: '😀'.repeat(800) } }), ['first']);
});
test('two uses reserve exactly one maintenance workflow and independent literal resources', () => {
  const input = toy(); const raw = JSON.parse(input.input_utf8);
  const row = raw.maintenance[0]; row.participants = [{ ...comparison, key: 'comparison' }];
  row.adoption_keys = ['comparison', 'toy-key']; row.observations = ['Evidence.'];
  input.mapping.cases[1].operations = { source: { kind: 'read', pointer: '/observations/0' } };
  input.mapping.cases[1].script = [['source']];
  input.input_utf8 = JSON.stringify(raw); input.input_sha256 = digest(input.input_utf8);
  input.mapping.tuning_sha256 = input.input_sha256; input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  const limits = caseLimits('toy-update', createEvaluation(input));
  for (const [key, expected] of Object.entries({ uses: 2, parent_requests: 6, worker_requests: 6, children: 4,
    review_write_attempts: 2, native_reads: 24, native_calls: 62, native_processes: 125, sdk_requests: 290,
    total_bytes: 59908096, deadline_ms: 195000 })) assert.equal(limits[key], expected, key);
  assert.equal(limits.parent_requests * 262144, 1572864);
  assert.equal(limits.worker_requests * 262144, 1572864);
  const meter = require('./inventory.cjs').createMeter({ mode: 'offline' }, 'offline', createEvaluation(input), {});
  assert.equal(meter.limits.requests, 17);
  const ceiling = require('./inventory.cjs').inventory().limits;
  assert.deepEqual([ceiling.requests, ceiling.parent_requests, ceiling.worker_requests], [222, 99, 123]);
});
