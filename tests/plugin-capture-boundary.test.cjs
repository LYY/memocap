const assert = require('node:assert/strict');
const test = require('node:test');
const { accessHost } = require('./plugin-access-fixture.cjs');
const { receipt, memory, repoID, repoPath } = require('./plugin-fixture.cjs');

test('frozen capture authorizes one immutable candidate and independently reads its normalized body', async () => {
  const phases = [];
  const current = await accessHost({ respond: (argv, settings, answer) => {
    if (argv[0] === 'remember') {
      settings.beforeSpawn();
      phases.push('spawn');
      return { receipt: receipt('remember', { status: 'inserted', returned_ids: [11], searched_placements: ['universal'] }) };
    }
    if (argv[0] === 'read') {
      const row = memory(11, 'normalized body');
      row.memory.placement = 'universal';
      return { receipt: receipt('read', { results: [row], returned_ids: [11] }) };
    }
    return answer;
  } });
  const tags = ['decision'];
  current.context.ask = async () => { phases.push('ask'); };
  const frozen = await current.operations.freezeCapture(current.context, {
    target: { repository_id: repoID(repoPath('A')), placement: 'universal' }, content: '  normalized body\n', tags,
    guard: async (phase) => { phases.push(phase); }, beforeSpawn: () => { phases.push('barrier'); },
  });
  tags.push('changed');
  const result = await frozen.execute();
  assert.equal(result.readback.status, 'ok');
  assert.deepEqual(phases, ['before_ask', 'ask', 'before_commit', 'barrier', 'spawn']);
  const write = current.calls.find(({ argv }) => argv[0] === 'remember').argv;
  assert.equal(write[write.indexOf('--tags') + 1], 'decision');
  assert.equal(write.at(-1), 'normalized body');
  assert.equal(current.calls.filter(({ argv }) => argv[0] === 'read').length, 1);
});

test('new input after capture approval prevents a stale command at the final barrier', async () => {
  const current = await accessHost();
  const frozen = await current.operations.freezeCapture(current.context, {
    target: { repository_id: repoID(repoPath('A')), placement: 'universal' }, content: 'withdrawn',
    guard: async (phase) => {
      if (phase === 'before_commit') current.runtime.invalidate(await current.runtime.context('A'));
    },
  });
  await assert.rejects(frozen.execute(), { code: 'invalid_request' });
  assert.equal(current.calls.some(({ argv }) => argv[0] === 'remember'), false);
});
