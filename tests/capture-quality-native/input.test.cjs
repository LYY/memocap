const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { carrierPlan, supportInputs } = require('./input.cjs');
const root = path.resolve(__dirname, '../..');
const tuning = JSON.parse(fs.readFileSync(path.join(root, 'tests/capture-evaluation/tuning.json'), 'utf8'));
const contract = JSON.parse(fs.readFileSync(path.join(root, 'tests/capture-evaluation/native-driver-contract.json'), 'utf8'));
const { fixtures } = require('./controller.cjs');
const { createHash } = require('node:crypto');

test('frozen tuning rejects changed input bytes against the independent public fixture digest', () => {
  const io = { readFileSync(file, encoding) {
    if (file.endsWith('/tuning.json')) return Buffer.from(`${fs.readFileSync(file, 'utf8')}\n`);
    return fs.readFileSync(file, encoding);
  } };
  assert.throws(() => fixtures(io), { code: 'frozen_tuning_hash_changed' });
});

test('public citation bindings match the complete synthetic tuning source and code point span', () => {
  for (const binding of Object.values(contract.bindings)) {
    const source = binding.pointer.split('/').slice(1).reduce((value, key) => value[key], tuning);
    assert.equal(createHash('sha256').update(source).digest('hex'), binding.content_hash);
    assert.equal([...source].slice(binding.span.start, binding.span.end).join(''), binding.quote);
  }
});

test('support preparation refuses changed source bytes even with a copied binding hash', () => {
  const binding = contract.bindings.queued_s1;
  const source = { complete: true, content_hash: binding.content_hash, text: `${binding.quote} changed` };
  assert.equal(supportInputs(contract, [source])[0].status, 'seam_not_reached');
});

test('read carrier projects only original user and original source bytes to a private physical path', () => {
  const plan = carrierPlan(tuning, '/task/private-canary');
  assert.deepEqual(plan.request, { parts: [{ type: 'text', text: 'Find the alpha entry.' }] });
  assert.equal(plan.carrier.original_locator, '/synthetic/quartz/docs/route.md');
  assert.equal(plan.carrier.physical_path, '/task/private-canary/docs/route.md');
  assert.equal(plan.carrier.bytes, 'For alpha, start at docs/alpha.md. Approval required. Never use for beta.');
  assert.equal(plan.source_evidence, null);
  assert.equal(Object.hasOwn(plan.request, 'gold'), false);
});

test('maintenance observation text cannot be promoted into a live independent check', () => {
  assert.equal(carrierPlan(tuning, '/task/private-canary').maintenance.status, 'blocked');
  assert.equal(carrierPlan(tuning, '/task/private-canary').maintenance.seed_quality_credit, false);
});

test('all eight support slots remain seam_not_reached when actual selected sources are absent', () => {
  const results = supportInputs(contract, []);
  assert.equal(results.length, 8);
  assert.ok(results.every((result) => result.status === 'seam_not_reached' && result.candidate === null));
});

test('partial citation bindings cannot replace full selected source provenance', () => {
  const source = { id: 'native-part', user_id: 'native-user', content_hash: contract.bindings.queued_s1.content_hash,
    text: contract.bindings.queued_s1.quote, complete: false };
  assert.equal(supportInputs(contract, [source])[0].status, 'seam_not_reached');
});

test('support preparation never synthesizes native completion or response envelopes', () => {
  const source = { id: 'native-part', user_id: 'native-user', content_hash: contract.bindings.queued_s1.content_hash,
    text: contract.bindings.queued_s1.quote, complete: true };
  const results = supportInputs(contract, [source]);
  assert.equal(results[0].status, 'blocked');
  assert.equal(results[0].reason, 'actual_native_task_and_selected_bundle_required');
  assert.equal(results[0].injected_first_stage, 'pending');
  assert.equal(results[0].native_completion, null);
});
