const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { readObservation, commandObservation } = require('./capture-source-host/synthetic.cjs');

async function context(observations, text = 'Locate the alpha route') {
  const { evidenceContext } = await import('../plugin/capture/context.js');
  const user = { info: { id: 'user', role: 'user' }, parts: [{ id: 'request', messageID: 'user', type: 'text', text }] };
  return evidenceContext([{ userID: 'user', at: 1700000000000, messages: [user,
    ...observations.map((observation) => ({ info: observation.message, parts: [observation.part] }))] }],
  { userID: 'user', targets: [{ repository_id: 'repository:fixture' }] }, '1.19.3');
}

test('keeps full sibling restrictions and ancestor conditions for support review', async () => {
  const text = '# Alpha only\n\nApproval required.\n\n## Entry\n\nStart at docs/alpha.md.\n\n## Restrictions\n\nNever use for beta.';
  const result = await context([readObservation(text)]);
  const source = result.packet.sources.find((entry) => entry.kind === 'file_content');
  assert.equal(source.text, text);
  const units = result.bundles.filter((bundle) => bundle.source_id === source.source_id).flatMap((bundle) => bundle.units);
  assert.ok(units.some((unit) => unit.text.includes('Never use for beta.')));
  assert.ok(units.some((unit) => unit.text.includes('Approval required.')));
});

test('source-supplied budgets cannot override frozen metadata computed from selected host evidence', async () => {
  const { captureBodyBudget } = await import('../plugin/capture/body-budget.js');
  const observation = readObservation('Approval required. Never use for beta.');
  const original = await context([observation]);
  const fake = { version: 9, max_body_cp: 999999, fixed_cp_by_statement_count: [0], reference_regions: [] };
  observation.part.body_budget = fake;
  observation.part.state.metadata.body_budget = fake;
  const result = await context([observation]);
  assert.deepEqual(result.packet.sources, original.packet.sources);
  assert.deepEqual(result.packet.bundles, original.packet.bundles);
  assert.deepEqual(result.packet.body_budget, original.packet.body_budget);
  assert.deepEqual(result.packet.body_budget, captureBodyBudget(result.sources, result.bundles));
  const budget = result.packet.body_budget;
  assert.ok([budget, budget.fixed_cp_by_statement_count, budget.reference_regions,
    ...budget.reference_regions, ...budget.reference_regions.map((region) => region.span)].every(Object.isFrozen));
  assert.ok(budget.reference_regions.length <= 12 && Buffer.byteLength(JSON.stringify(budget)) <= 4096);
  const serialized = JSON.stringify(result.packet);
  assert.deepEqual(result.inputProvenance.packet, { sha256: createHash('sha256').update(serialized).digest('hex'),
    utf8_bytes: Buffer.byteLength(serialized) });
});

test('drops whole oversized bundle instead of offering a misleading prefix', async () => {
  const text = `# Alpha\n\nStart at docs/alpha.md.\n\n${'Condition applies. '.repeat(200)}\nNever use for beta.`;
  const result = await context([readObservation(text)]);
  assert.equal(result.packet.sources.some((entry) => entry.kind === 'file_content'), false);
});

test('offers a complete numbered runbook as evidence without copying it into a memory', async () => {
  const result = await context([readObservation('# Release\n\n1. Get approval.\n2. Submit.\n3. Independently verify.')], 'Read Release approval');
  assert.equal(result.packet.sources.some((entry) => entry.kind === 'file_content'), true);
});

test('rejects truncated or offset read output as a verified file source', async () => {
  const observation = readObservation('Alpha entry requires approval.');
  observation.part.state.input.offset = 2;
  const result = await context([observation]);
  assert.equal(result.packet.sources.some((entry) => entry.kind === 'file_content'), false);
});

test('does not promote exit zero to business-success authority', async () => {
  const result = await context([commandObservation('queued', 0)], 'Inspect queued result');
  const source = result.packet.sources.find((entry) => entry.kind === 'command_result');
  assert.equal(source.authority, 'observed_result');
  assert.equal(source.outcome.type, 'process_exit');
});

test('screens late source metadata before context selection', async () => {
  const observation = readObservation('Approval required.');
  observation.part.state.metadata.hidden = 'api_key=synthetic-sensitive-value';
  await assert.rejects(context([observation]), { code: 'secret' });
});

test('assistant claims remain outside the source inventory', async () => {
  const observation = readObservation();
  observation.part = { id: 'claim', messageID: 'message', type: 'text', text: 'The business operation succeeded.' };
  const result = await context([observation]);
  assert.deepEqual(result.packet.sources.map((source) => source.kind), ['user_statement']);
});

test('retained prior and current inclusion has byte-bound provenance independent of proposal content', async () => {
  const { evidenceContext } = await import('../plugin/capture/context.js');
  const frames = ['prior', 'current'].map((userID, index) => ({ userID, at: index + 1, messages: [
    { info: { id: userID, role: 'user' }, parts: [{ id: `${userID}_part`, type: 'text',
      text: index ? 'Continue Alpha route.' : 'Alpha route requires approval.' }] }] }));
  const result = evidenceContext(frames, { userID: 'current', targets: [{ repository_id: 'repository:fixture' }] }, '1.19.3');
  const serialized = JSON.stringify(result.packet);
  assert.ok(result.inputProvenance, 'selected input provenance must exist even for empty candidates');
  assert.deepEqual(result.inputProvenance.packet, { sha256: createHash('sha256').update(serialized).digest('hex'),
    utf8_bytes: Buffer.byteLength(serialized) });
  assert.ok(result.packet.body_budget, 'budget must precede packet hashing');
  assert.equal(Object.isFrozen(result.packet.body_budget.reference_regions[0].span), true);
  assert.deepEqual(result.inputProvenance.selected_sources.entries.map((source) => source.source_id), ['prior_part', 'current_part']);
  assert.deepEqual(result.inputProvenance.retained_frames.entries.map((frame) => frame.user_id), ['prior', 'current']);
  assert.equal(Object.isFrozen(result.inputProvenance.selected_sources.entries[0].span), true);
  frames[0].messages[0].parts[0].text = 'Changed after snapshot';
  assert.equal(result.inputProvenance.selected_sources.entries[0].content_hash,
    createHash('sha256').update('Alpha route requires approval.').digest('hex'));
  assert.equal(JSON.stringify(result.inputProvenance).includes('Alpha route'), false);
});

test('retained but unselected source is distinct from a frame outside retained custody', async (t) => {
  const { createObserved } = await import('../plugin/capture/observed.js');
  const { evidenceContext } = await import('../plugin/capture/context.js');
  const cache = createObserved();
  t.after(() => cache.dispose());
  cache.observe({ sessionID: 'root' }, { message: { id: 'prior', role: 'user' },
    parts: [{ id: 'oversized', type: 'text', text: 'Alpha '.repeat(600) }] });
  cache.event({ type: 'message.updated', properties: { info: { sessionID: 'root', id: 'answer', role: 'assistant',
    parentID: 'prior', finish: 'stop', time: { created: 1, completed: 2 } } } });
  cache.bind('root', 'prior', 'origin');
  cache.observe({ sessionID: 'root' }, { message: { id: 'current', role: 'user' },
    parts: [{ id: 'request', type: 'text', text: 'Continue Alpha route.' }] });
  const turn = { userID: 'current', targets: [] };
  const retained = evidenceContext(cache.frame('root', 'current', 'origin'), turn, '1.19.3').inputProvenance;
  cache.breakContinuity('root', 'current');
  const excluded = evidenceContext(cache.frame('root', 'current', 'origin'), turn, '1.19.3').inputProvenance;
  assert.ok(retained, 'retained custody must be observable');
  assert.equal(retained.adapted_sources.entries.some((source) => source.source_id === 'oversized'), true);
  assert.equal(retained.selected_sources.entries.some((source) => source.source_id === 'oversized'), false);
  assert.equal(excluded.retained_frames.entries.some((frame) => frame.user_id === 'prior'), false);
  assert.equal(excluded.upstream_observation.status, 'unknown');
});

test('omitted observed parts remain unknown rather than proving source absence', async (t) => {
  const { createObserved } = await import('../plugin/capture/observed.js');
  const { evidenceContext } = await import('../plugin/capture/context.js');
  const cache = createObserved();
  t.after(() => cache.dispose());
  cache.observe({ sessionID: 'root' }, { message: { id: 'user', role: 'user' }, parts: [
    { id: 'request', type: 'text', text: 'Inspect Alpha.' }] });
  cache.event({ type: 'message.updated', properties: { info: { sessionID: 'root', id: 'assistant', role: 'assistant',
    parentID: 'user', finish: 'stop', time: { created: 1, completed: 2 } } } });
  const oversized = readObservation('x'.repeat(9000));
  cache.event({ type: 'message.part.updated', properties: { part: { ...oversized.part, sessionID: 'root', messageID: 'assistant' } } });
  const result = evidenceContext(cache.frame('root', 'user', 'origin'), { userID: 'user', targets: [] }, '1.19.3');
  assert.equal(result.inputProvenance?.upstream_observation.status, 'unknown');
  assert.equal(result.inputProvenance.source_parts.total, 2);
  assert.equal(result.inputProvenance.source_parts.entries[1].adaptation, 'skip');
});

test('diagnostic cap declares partial coverage while selected packet remains intact', async () => {
  const { evidenceContext } = await import('../plugin/capture/context.js');
  const { captureSourceProfile } = await import('../plugin/capture/sources/profile.js');
  const frames = [{ userID: 'user', at: 1, messages: [{ info: { id: 'user', role: 'user' },
    parts: Array.from({ length: 60 }, (_, index) => ({ id: `part_${index}`, type: 'text', text: `Alpha condition ${index}.` })) }] }];
  const result = evidenceContext(frames, { userID: 'user', targets: [] }, '1.19.3');
  assert.equal(result.inputProvenance?.completeness, 'partial');
  assert.ok(Buffer.byteLength(JSON.stringify(result.inputProvenance)) <= captureSourceProfile.max_selected_bytes);
  assert.ok(Object.values(result.inputProvenance).some((section) => section?.omitted > 0));
  assert.equal(result.inputProvenance.packet.sha256, createHash('sha256').update(JSON.stringify(result.packet)).digest('hex'));
});

test('constraint provenance identifies known receipt bytes without exposing memory text', async () => {
  const { evidenceContext } = await import('../plugin/capture/context.js');
  const { fullReadConstraint } = await import('../plugin/capture/constraints.js');
  const content = 'Alpha requires approval 😀.';
  const content_hash = createHash('sha256').update(content).digest('hex');
  const constraint = fullReadConstraint({ status: 'ok', operation: 'read', operation_id: 'receipt', record_changed: false,
    results: [{ completeness: 'full', content_hash, memory: { id: 2, placement: 'universal', content } }] },
  { id: 2, placement: 'universal' }, { rootID: 'root', userID: 'user', messageID: 'answer' });
  const frames = [{ userID: 'user', at: 1, constraints: [constraint], messages: [{ info: { id: 'user', role: 'user' },
    parts: [{ id: 'part', type: 'text', text: 'Continue Alpha.' }] }] }];
  const result = evidenceContext(frames, { userID: 'user', targets: [] }, '1.19.3');
  assert.deepEqual(result.inputProvenance.constraints.entries, [{ id: 2,
    placement_sha256: createHash('sha256').update('universal').digest('hex'), user_id: 'user', message_id: 'answer',
    receipt_id: 'receipt', content_hash }]);
  assert.equal(JSON.stringify(result.inputProvenance).includes(content), false);
  assert.equal(result.packet.constraints[0].content, content);
});
