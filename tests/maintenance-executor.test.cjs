const assert = require('node:assert/strict');
const test = require('node:test');
const { maintenanceFixture, database, task, snapshot } = require('./maintenance-fixture.cjs');

async function executorFixture(context, current) {
  const { createMaintenanceExecutor } = await import('../plugin/maintenance/executor.js');
  const { requireMaintenance } = await import('../plugin/maintenance/boundary.js');
  current.review(current.decision);
  const proposal = current.registry.freeze(current.decision, current.host);
  const args = { operation: 'apply', proposal_id: proposal.proposal_id };
  const turn = { task, agent: 'build', controller: new AbortController(), proposal, tool_calls: 1,
    origin: 'origin', sourceHash: 'source', write_attempts: 0, phase: 'commit' };
  const worker = { turn, stage: 'commit', callID: 'commit-call' };
  const state = { generation: 4 };
  const control = { epoch: 2, source: 'source', beforeDispatch() {}, dispatches: [], checks: [] };
  const client = {
    config: { async get() { return { data: current.policy.config }; } },
    app: { async agents() { return { data: [{ name: 'build', permission: [] }] }; } },
    session: {
      async get({ path }) { return { data: { id: path.id, permission: current.policy.session } }; },
      async messages() { return { data: [{ info: { id: 'commit-message' }, parts: [{ type: 'tool', tool: 'memocap_maintain',
        callID: 'commit-call', state: { status: 'running', input: args } }] }] }; },
    },
  };
  const toolContext = { sessionID: 'worker', messageID: 'commit-message', abort: turn.controller.signal,
    async ask() { control.checks.push('ask'); } };
  const backend = {
    async read() {
      control.checks.push('read');
      return { database, records: current.state.records.map((record) => ({ snapshot: record })) };
    },
    async commit(_proposal, dispatch) {
      control.beforeDispatch(dispatch);
      dispatch.beforeSpawn({ database });
      control.dispatches.push(structuredClone(dispatch.request));
      return { status: 'committed', outcome: 'committed', no_replay: true };
    },
  };
  const execute = createMaintenanceExecutor({ client, backend, registry: current.registry, gate: current.gate,
    tasks: { workers: new Map([['worker', worker]]), check() { requireMaintenance(!turn.controller.signal.aborted, 'worker_signal'); },
      sourceHash: () => control.source, invalidate() { turn.reason = 'worker_signal'; } },
    runtime: { readPermission: { async check() { control.checks.push('readPermission'); } },
      async context() { return state; }, invalidateCache() {} },
    origin: async () => turn.origin, configEpoch: () => control.epoch,
    setCurrent(observed) { Object.assign(current.state, observed); },
  });
  context.after(() => current.registry.dispose());
  return { execute: () => execute(args, toolContext), control, backend, turn, state, proposal };
}

test('executor submits a literal refine request with ordered nonparticipant dependencies', async (context) => {
  const current = await maintenanceFixture();
  current.host.use_ids = [current.used[2].use_id, current.used[0].use_id, current.used[1].use_id];
  current.state.records = [current.records[2], current.records[0], current.records[1]];
  const host = await executorFixture(context, current);

  const result = await host.execute();

  assert.equal(result.status, 'committed');
  assert.deepEqual(host.control.dispatches, [{ mode: 'all', group: { action: 'refine', expected: snapshot(), content: 'new route' },
    dependencies: [snapshot(9, 'C condition'), snapshot(8, 'B route')] }]);
  assert.deepEqual(host.control.checks, ['ask', 'readPermission', 'read']);
  assert.equal(host.turn.write_attempts, 1);
  assert.equal(host.turn.phase, 'dispatched');
  assert.throws(() => current.registry.consume(host.proposal.proposal_id), { code: 'reference_unavailable' });
});

test('executor submits merge sources in decision order with the exact survivor', async (context) => {
  const current = await maintenanceFixture();
  current.rebind('merge', [0, 2, 1]);
  current.host.use_ids = current.used.map((entry) => entry.use_id);
  current.decision = { ...current.decision, action: 'merge', sources: [current.used[2].use_id, current.used[1].use_id] };
  const host = await executorFixture(context, current);

  await host.execute();

  assert.deepEqual(host.control.dispatches, [{ mode: 'all', group: { action: 'merge', survivor: snapshot(), content: 'new route',
    sources: [snapshot(9, 'C condition'), snapshot(8, 'B route')] }, dependencies: [] }]);
});

test('executor submits delete with the exact expected snapshot and retained dependency', async (context) => {
  const current = await maintenanceFixture();
  current.rebind('delete', [0]);
  current.host.evidence = [{ ...current.evidence[0], kind: 'retirement' }];
  current.host.use_ids.push(current.used[1].use_id);
  current.state.records.push(current.records[1]);
  current.decision = { action: 'delete', target: current.used[0].use_id, citations: [current.citation],
    retirement_evidence_ids: ['observed'], remaining_unique_facts: [] };
  const host = await executorFixture(context, current);

  await host.execute();

  assert.deepEqual(host.control.dispatches, [{ mode: 'all', group: { action: 'delete', expected: snapshot() },
    dependencies: [snapshot(8, 'B route')] }]);
});

for (const [change, code] of [['body', 'proposal_changed'], ['epoch', 'permission_changed'], ['generation', 'permission_changed'],
  ['source', 'source_changed'], ['abort', 'worker_signal'], ['attempt', 'attempt_consumed'],
  ['snapshot', 'snapshot_changed'], ['permission', 'permission_deny'], ['database', 'database_changed']]) {
  test(`executor dispatches nothing when ${change} changes before the synchronous barrier`, async (context) => {
    const current = await maintenanceFixture();
    const host = await executorFixture(context, current);
    host.control.beforeDispatch = (dispatch) => {
      switch (change) {
        case 'body': dispatch.request.group.content = 'tampered'; break;
        case 'epoch': host.control.epoch++; break;
        case 'generation': host.state.generation++; break;
        case 'source': host.control.source = 'changed'; break;
        case 'abort': host.turn.controller.abort(); break;
        case 'attempt': host.turn.write_attempts++; break;
        case 'snapshot': current.state.records[0].content = 'changed'; break;
        case 'permission': current.policy.session.push({ permission: 'memocap_maintain', pattern: '*', action: 'deny' }); break;
        case 'database': {
          const beforeSpawn = dispatch.beforeSpawn;
          dispatch.beforeSpawn = () => beforeSpawn({ database: '/synthetic/changed.db' });
          break;
        }
        default: assert.fail('unhandled test change');
      }
    };

    const result = await host.execute();

    assert.notEqual(result.status, 'committed');
    assert.equal(result.error.code, code);
    assert.equal(result.no_replay, true);
    assert.deepEqual(host.control.dispatches, []);
  });
}

test('an unknown dispatched outcome cannot replay the consumed worker or proposal', async (context) => {
  const current = await maintenanceFixture();
  const host = await executorFixture(context, current);
  const commit = host.backend.commit;
  host.backend.commit = async (...args) => { await commit(...args); throw new Error('lost response'); };
  assert.equal((await host.execute()).status, 'unknown');

  const replay = await host.execute();

  assert.equal(replay.no_replay, true);
  assert.equal(host.control.dispatches.length, 1);
  assert.equal(host.turn.write_attempts, 1);
  assert.throws(() => current.registry.consume(host.proposal.proposal_id), { code: 'reference_unavailable' });
});
