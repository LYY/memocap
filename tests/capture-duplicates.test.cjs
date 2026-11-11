const assert = require('node:assert/strict');
const test = require('node:test');
const { memory, receipt } = require('./plugin-fixture.cjs');

async function fixture() {
  const { identify } = await import('../plugin/capture/identity.js');
  const { checkDuplicate } = await import('../plugin/capture/duplicates.js');
  const candidate = identify([{ text: 'Use docs/alpha.md only for alpha.', pointer: 'tool:a/call-a' }], memory().memory.placement);
  const calls = [];
  const entry = memory(7, candidate.body);
  entry.memory.tags = candidate.tag;
  const runtime = {
    readPermission: { check: async () => {}, authorize: async (...args) => calls.push(['authorize', ...args]) },
    recall: async (...args) => { calls.push(['recall', ...args]); return { status: 'ok', results: [{ ...entry, completeness: 'partial', memory: { ...entry.memory, content: 'preview' } }] }; },
    request: async (...args) => { calls.push(['request', ...args]); return receipt('read', { results: [entry], returned_ids: [7] }); },
  };
  const turn = { parentID: 'parent', agent: 'build', candidate, parentState: {}, targets: [], controller: new AbortController() };
  return { run: () => checkDuplicate(runtime, turn, { check() {} }), runtime, calls, entry, candidate };
}

test('a partial duplicate hit is authorized and read by exact ID before comparison', async () => {
  const current = await fixture();
  await assert.rejects(current.run(), { code: 'duplicate_body' });
  const read = current.calls.find(([operation]) => operation === 'request');
  assert.deepEqual(read[2].slice(0, 4), ['read', '7', '--placement', current.candidate.placement]);
  const grant = current.calls.find(([operation]) => operation === 'authorize');
  assert.equal(grant[2].id, 7);
  assert.equal(grant[2].placement, current.candidate.placement);
});

test('a failed lookup blocks capture before any full read or commit', async () => {
  const current = await fixture();
  current.runtime.recall = async () => ({ status: 'failed', results: [] });
  await assert.rejects(current.run(), { code: 'duplicate_lookup_failed' });
  assert.equal(current.calls.length, 0);
});

test('a failed exact read propagates and cannot become permission to write', async () => {
  const current = await fixture();
  current.runtime.request = async () => { throw Object.assign(new Error('read failed'), { code: 'cli_failed' }); };
  await assert.rejects(current.run(), { code: 'cli_failed' });
});

test('a different condition with the same tag is not treated as duplicate', async () => {
  const current = await fixture();
  current.entry.memory.content = current.entry.memory.content.replace('only for alpha', 'only for beta');
  await current.run();
});

test('a different placement with the same raw body and tag is not treated as duplicate', async () => {
  const current = await fixture();
  current.entry.memory.placement = 'universal';
  await current.run();
});
