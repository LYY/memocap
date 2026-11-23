const assert = require('node:assert/strict');
const test = require('node:test');
const { toy, digest } = require('./evaluation-fixture.cjs');
const selection = require('./population.cjs');
const { runCase } = require('./adapter.cjs');
const { fakeHost } = require('./fake-host.cjs');
const { inventory } = require('./inventory.cjs');
const { basePermissions, preparePermissions } = require('./permission-configuration.cjs');

test('explicit alternate bytes reach dispatcher carrier and adapter without evaluator controls', async () => {
  const input = toy(); const evaluation = selection.createEvaluation(input);
  const selected = selection.population(evaluation); const host = fakeHost();
  const result = await runCase('toy-read', { population: selected, host, budget: { mode: 'offline' } });
  assert.equal(result.status, 'wired', result.reason);
  assert.equal(host.packets[0].user, 'Read the disposable toy note.');
  assert.equal(host.translations[0].text, 'Toy observation.');
  assert.equal(JSON.stringify([host.packets, host.translations, selected.createDispatcher('toy-read').model.input()])
    .includes('sealed'), false);
  assert.equal(Object.isFrozen(evaluation.mapping.cases[0]), true);
  input.mapping.cases[0].id = 'changed';
  assert.equal(evaluation.mapping.cases[0].id, 'toy-read');
  assert.equal(inventory(selected).cases.length, 2);
  assert.equal(inventory(selected).tuning_sha256, input.input_sha256);
  assert.equal(inventory().cases.length, 28);
});

test('selected authorization config uses alternate record before native setup', async () => {
  const evaluation = selection.createEvaluation(toy()); const calls = [];
  const origin = `repository:${'c'.repeat(64)}`;
  const setup = await preparePermissions('toy-update', { async initialize() { calls.push('init'); return origin; },
    async seed(record) { calls.push(record.content); return { id: 17, ...record, readback: { id: 17, ...record } }; } },
  '/toy/memory.db', evaluation);
  assert.deepEqual(calls, ['init', 'Toy primary.']);
  assert.equal(basePermissions('toy-update', evaluation)['*'], 'ask');
  assert.equal(Object.values(setup.permission.memocap_maintain)[0], 'allow');
  await assert.rejects(preparePermissions('foreign', { initialize() { assert.fail('foreign initialized'); } },
    '/toy/memory.db', evaluation), /unmapped_case/);
});

for (const mutate of [
  (input) => { input.input_utf8 += ' '; },
  (input) => { input.mapping.cases[0].id = 'foreign'; },
  (input) => { input.input_sha256 = 'a'.repeat(64); },
  (input) => { input.mapping_sha256 = 'b'.repeat(64); },
]) test('mismatched explicit input or mapping is rejected', () => {
  const input = toy(); mutate(input);
  assert.throws(() => selection.createEvaluation(input), { code: 'evaluation_digest_mismatch' });
});
test('null evaluation input is rejected with the typed digest error', () => {
  assert.throws(() => selection.createEvaluation(null), { name: 'TransportBlocked', code: 'evaluation_digest_mismatch' });
});
test('matching digests cannot admit gold as a source operation', () => {
  const input = toy(); input.mapping.cases[0].operations.source.pointer = '/gold';
  input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  assert.throws(() => selection.createEvaluation(input), /evaluation_source_pointer/);
});
test('foreign IDs and more than 28 cases cannot enter the selected population', () => {
  const input = toy(); input.mapping.cases = Array.from({ length: 29 }, () => input.mapping.cases[0]);
  input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  assert.throws(() => selection.createEvaluation(input), /finite_evaluation_cases/);
});
test('compiled selection cannot substitute foreign closures or a mismatched digest', () => {
  const selected = selection.population(selection.createEvaluation(toy()));
  const forged = { ...selected, resolveCase() { assert.fail('foreign closure'); } };
  assert.equal(selection.population(forged).resolveCase('toy-read').original.id, 'toy-read');
  assert.throws(() => selection.population({ ...selection.tuningPopulation,
    mapping: { ...selection.tuningPopulation.mapping, tuning_sha256: 'a'.repeat(64) } }), /explicit_frozen_population_required/);
});
test('maintenance model facade projects snapshots without nested gold', () => {
  const input = toy(); const raw = JSON.parse(input.input_utf8);
  raw.maintenance[0].record.gold = 'sealed-record-control';
  input.input_utf8 = JSON.stringify(raw); input.input_sha256 = digest(input.input_utf8);
  input.mapping.tuning_sha256 = input.input_sha256; input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  const selected = selection.population(selection.createEvaluation(input));
  assert.equal(JSON.stringify(selected.createDispatcher('toy-update').model.input()).includes('sealed'), false);
});
test('selected grant cannot raise any existing resource ceiling', () => {
  const { createMeter } = require('./inventory.cjs'); const { hash } = require('./value.cjs');
  const selected = selection.population(selection.createEvaluation(toy())); const needed = inventory(selected);
  const grant = { mode: 'native', approved: true, approval_id: 'toy', population_sha256: needed.tuning_sha256,
    inventory_sha256: hash(needed), evaluation_sha256: needed.evaluation_sha256,
    limits: { ...inventory().limits, requests: 223 } };
  assert.throws(() => createMeter(grant, 'native', selected), /finite_evaluation_budget/);
});
test('nested tool input controls cannot cross the dispatcher model facade', () => {
  const input = toy(); const raw = JSON.parse(input.input_utf8);
  raw.capture[0].turns[0].tools[0].input.gold = { sealed: 'nested-control' };
  input.input_utf8 = JSON.stringify(raw); input.input_sha256 = digest(input.input_utf8);
  input.mapping.tuning_sha256 = input.input_sha256; input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  const selected = selection.population(selection.createEvaluation(input));
  const result = selected.createDispatcher('toy-read').model.execute('source');
  assert.deepEqual(result.value.tool.input, { filePath: '/toy/note.md' });
});
