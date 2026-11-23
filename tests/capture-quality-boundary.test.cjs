const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyIsolation, savedPrecision, generationReply } = require('./capture-quality-boundary.cjs');
const { qualityContext } = require('./capture-quality-input.cjs');

const isolated = () => ({ pure: true, plugins: [], mcp: {
  'code-review-graph': { status: 'disabled' }, 'metabase-bridge': { status: 'disabled' },
}, tools: ['read', 'bash'], disabled: { read: false, bash: false } });

test('generation is blocked when a business MCP remains connected', () => {
  const state = isolated();
  state.mcp['metabase-bridge'].status = 'connected';
  assert.throws(() => verifyIsolation(state), { code: 'mcp_enabled' });
});
test('generation is blocked when an available tool is not disabled', () => {
  const state = isolated();
  delete state.disabled.bash;
  assert.throws(() => verifyIsolation(state), { code: 'tool_enabled' });
});
test('generation is blocked when plugin isolation is unproven', () => {
  const state = isolated();
  state.plugins = ['external-memory'];
  assert.throws(() => verifyIsolation(state), { code: 'plugin_enabled' });
});
test('admitted JSON never contributes to saved precision', () => {
  const metric = savedPrecision([{ admitted: true, adjudicated: true, correct: true }]);
  assert.deepEqual(metric, { status: 'not_applicable', numerator: 0, denominator: 0, value: null });
});
test('unadjudicated persisted candidates block precision', () => {
  assert.equal(savedPrecision([{ persistence: { verified: true, id: 7, placement: 'universal',
    expected: 'route', actual: 'route' } }]).status, 'blocked');
});
test('precision uses independently adjudicated verified persisted candidates only', () => {
  const persistence = { verified: true, id: 7, placement: 'universal', expected: 'route', actual: 'route' };
  assert.deepEqual(savedPrecision([{ persistence, adjudicated: true, correct: false },
    { admitted: true, adjudicated: true, correct: true }]),
  { status: 'measured', numerator: 0, denominator: 1, value: 0 });
});
test('provider errors and tool calls cannot become semantic replies', () => {
  assert.throws(() => generationReply({ data: { info: { finish: 'stop', error: { name: 'APIError' } }, parts: [] } }),
    { code: 'provider_error' });
  assert.throws(() => generationReply({ data: { info: { finish: 'stop' }, parts: [{ type: 'tool' }] } }),
    { code: 'unexpected_tool' });
});
test('tuning read evidence reaches the actual production packet with matching source locator', async () => {
  const fixture = { turns: [{ user: 'Inspect alpha.', tools: [{ path: '/synthetic/quartz/docs/route.md',
    output: 'For alpha approval is required; beta is excluded.' }] }] };
  const { context } = await qualityContext(fixture);
  const read = context.packet.sources.find((entry) => entry.kind === 'file_content');
  assert.equal(read?.text, 'For alpha approval is required; beta is excluded.');
  assert.equal(read.pointer.locator, '/synthetic/quartz/docs/route.md');
});
