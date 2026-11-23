const assert = require('node:assert/strict');
const test = require('node:test');
const { controlledParent } = require('./controlled-parent.cjs');
const { hash } = require('./value.cjs');
const origin = 'repository:toy';
function driver(memories) {
  const charged = []; const parent = controlledParent({ endpoints: ['https://inert.invalid/responses'],
    charge: (...args) => charged.push(args), flush: async () => {} });
  parent.bind({ root: 'root', user: 'Read.', operations: [], memories }); parent.user('user');
  const history = []; const calls = [];
  return { parent, charged, calls, async next() {
    parent.reserve();
    const response = await parent.respond(new Request('https://inert.invalid/responses', { method: 'POST',
      body: JSON.stringify({ model: 'gpt-6.1-sol', stream: true, input: history,
        tools: ['memocap_read', 'memocap_maintain'].map((name) => ({ type: 'function', name })) }) }));
    const frames = (await response.text()).trim().split('\n\n').map((line) => JSON.parse(line.slice(6)));
    const call = frames.find((frame) => frame.type === 'response.output_item.done').item;
    calls.push(call); return call;
  }, finish(call, receipt) {
    const args = JSON.parse(call.arguments); const output = JSON.stringify(receipt);
    parent.before({ sessionID: 'root', callID: call.call_id, tool: call.name }, args);
    parent.terminal({ callID: call.call_id, sessionID: 'root', tool: call.name,
      state: { status: 'completed', input: args, output } }, { sessionID: 'root', parentID: 'user' });
    history.push({ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
      { type: 'function_call_output', call_id: call.call_id, output });
  } };
}
const memories = () => [71, 99].map((id, index) => ({ id, placement: origin, role: index ? 'comparison' : 'primary', access: 'read', declaration: 'use' }));
const fullRead = (id) => ({ status: 'ok', maintenance_read: { id, placement: origin, receipt_id: `read-${id}`, content_hash: hash(`Body ${id}.`) },
  results: [{ completeness: 'full', memory: { id, placement: origin, content: `Body ${id}.` } }] });
test('in-memory public controller reads both before using each distinct actual receipt', async () => {
  const current = driver(memories());
  for (const id of [71, 99]) { const call = await current.next(); assert.equal(call.name, 'memocap_read'); current.finish(call, fullRead(id)); }
  for (const id of [71, 99]) {
    const call = await current.next(); assert.equal(call.name, 'memocap_maintain');
    assert.deepEqual(JSON.parse(call.arguments), { operation: 'use', ...fullRead(id).maintenance_read, statements: [`Body ${id}.`] });
    current.finish(call, { status: 'used', use_id: `use-${id}`, id, placement: origin, content_hash: hash(`Body ${id}.`) });
  }
  assert.equal((await current.next()).type, 'message');
  assert.equal(current.parent.snapshot().dispatches, 5);
});
for (const change of [(rows) => { rows[1].access = 'recall'; }, (rows) => { rows[1].id = 71; },
  (rows) => { rows.push({ ...rows[1], id: 100 }); }, (rows) => { rows[1].id = '99'; }]) {
  test('invalid declaration packet is rejected before local reservation', () => {
    const rows = memories(); change(rows);
    assert.throws(() => driver(rows), { code: 'controlled_adoption_packet' });
  });
}
for (const change of [(receipt) => { receipt.id = 99; }, (receipt) => { receipt.placement = 'universal'; },
  (receipt) => { receipt.content_hash = hash('stale'); }, (receipt) => { delete receipt.use_id; }]) {
  test('actual use terminal must match its full read', async () => {
    const current = driver([memories()[0]]); current.finish(await current.next(), fullRead(71));
    const call = await current.next(); const receipt = { status: 'used', use_id: 'use-71', id: 71, placement: origin, content_hash: hash('Body 71.') };
    change(receipt); assert.throws(() => current.finish(call, receipt), { code: 'controlled_use_missing' });
  });
}
test('duplicate use handles are refused across two actual uses', async () => {
  const current = driver(memories());
  for (const id of [71, 99]) current.finish(await current.next(), fullRead(id));
  current.finish(await current.next(), { status: 'used', use_id: 'same', id: 71, placement: origin, content_hash: hash('Body 71.') });
  const call = await current.next();
  assert.throws(() => current.finish(call, { status: 'used', use_id: 'same', id: 99, placement: origin, content_hash: hash('Body 99.') }), { code: 'controlled_use_missing' });
});
test('public fixture produces two real product use handles through injected native reads', async () => {
  const { createFixture } = require('./fixture.cjs');
  const { productionProbe } = require('./production-probe.cjs');
  const { fixture, receipt, organizationReceipt, organizationSnapshot } = require('../plugin-fixture.cjs');
  const probe = await productionProbe();
  (await probe.load('node:fs')).setExport('realpathSync', (value) => value);
  const base = fixture(); const placement = `repository:${'b'.repeat(64)}`;
  const rows = [71, 99].map((id) => ({ ...organizationSnapshot(id, `Distinct body ${id}.`), placement, scope: 'repository' }));
  const observed = []; const nativeCalls = []; const charged = [];
  const hooks = await createFixture(base.input, { factory: probe.factory, execution_profile: 'controlled_native_parent_genuine_curator_v1',
    endpoints: ['https://inert.invalid/responses'], writeCarrier() {}, binding() {}, charge() {}, flush: async () => {},
    database: () => '/synthetic/memory.db', async invoke(argv, options) {
      nativeCalls.push(argv);
      if (argv[0] === 'organize') return { receipt: organizationReceipt('read', { database: '/synthetic/memory.db',
        records: JSON.parse(options.stdin).keys.map((key) => ({ ...key, snapshot: rows.find((row) => row.id === key.id) })) }) };
      return { receipt: receipt(argv[0] === 'scope' ? 'scope_resolve' : argv[0], {
        targets: [{ canonical_path: base.input.directory, repository_id: placement, identity_source: 'directory', placements: [placement], descriptor: null, observed_at: null }],
        results: argv[0] === 'read' ? [{ memory: rows.find((row) => row.id === Number(argv[1])),
          source_order: 0, visibility: 'visible', applicability: 'unknown', applicable_repositories: [] }] : [],
        returned_ids: argv[0] === 'read' ? [Number(argv[1])] : [] }) };
    } });
  try {
    await hooks.config(base.config);
    hooks.bind({ root: 'root', user: 'Review supplied records.', operations: [], memories: memories().map((row) => ({ ...row, placement })) },
      { user() {}, record: (event) => observed.push(event), charge: (key) => charged.push(key) });
    await hooks['chat.message']({ sessionID: 'root', agent: 'build' }, { message: { id: 'user', role: 'user' },
      parts: [{ id: 'user-text', type: 'text', text: 'Review supplied records.' }] });
    const history = [];
    for (let index = 0; index < 5; index++) {
      await hooks['chat.params']({ sessionID: 'root' }, {});
      const response = await hooks.controlledProvider('https://inert.invalid/responses', { method: 'POST',
        headers: { [require('./egress.cjs').correlation]: 'root' }, body: JSON.stringify({ model: 'gpt-6.1-sol', stream: true, input: history,
          tools: ['memocap_read', 'memocap_maintain'].map((name) => ({ type: 'function', name })) }) },
      () => { throw new Error('genuine_transport_forbidden'); });
      const frames = (await response.text()).trim().split('\n\n').map((line) => JSON.parse(line.slice(6)));
      const call = frames.find((frame) => frame.type === 'response.output_item.done').item;
      if (index === 4) { assert.equal(call.type, 'message'); break; }
      const args = JSON.parse(call.arguments); const messageID = `message-${index}`;
      await hooks.event({ event: { type: 'message.updated', properties: { info: { id: messageID, sessionID: 'root', parentID: 'user', role: 'assistant' } } } });
      await hooks['tool.execute.before']({ sessionID: 'root', callID: call.call_id, tool: call.name }, { args });
      const value = await hooks.tool[call.name].execute(args, { sessionID: 'root', messageID, agent: 'build',
        abort: new AbortController().signal, ask: async () => {}, metadata() {} });
      const output = typeof value === 'string' ? value : value.output;
      assert.equal(JSON.parse(output).status, index < 2 ? 'ok' : 'used');
      if (index < 2) {
        const result = JSON.parse(output);
        assert.equal(result.results[0].completeness, 'full');
        assert.deepEqual([result.results[0].memory.id, result.results[0].memory.placement], [args.id, args.placement]);
        assert.deepEqual([result.maintenance_read.id, result.maintenance_read.placement], [args.id, args.placement]);
        assert.equal(result.maintenance_read.content_hash, hash(result.results[0].memory.content));
      }
      await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
        id: `part-${index}`, messageID, sessionID: 'root', type: 'tool', tool: call.name, callID: call.call_id,
        state: { status: 'completed', input: args, output, time: { start: 1, end: 2 } } } } } });
      history.push({ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.call_id, output });
    }
    const uses = observed.filter((event) => event.kind === 'memory.use');
    assert.deepEqual(uses.map((event) => event.id), [71, 99]);
    assert.equal(new Set(uses.map((event) => event.use_id)).size, 2);
    assert.equal(new Set(uses.map((event) => event.receipt_id)).size, 2);
    for (const use of uses) assert.equal(use.content_hash, hash(rows.find((row) => row.id === use.id).content));
    assert.equal(nativeCalls.some((argv) => ['remember', 'maintain'].includes(argv[0]) || argv[1] === 'maintain'), false);
    assert.deepEqual(probe.defaults, []); assert.equal(charged.filter((key) => key === 'scripted_root_generations').length, 5);
  } finally { await hooks.dispose(); }
});
test('noncontrolled public fixture reserves all declared uses plus terminal generation', async () => {
  const { createFixture } = require('./fixture.cjs'); const calls = [];
  const hooks = await createFixture({ client: { session: {} } }, { binding() {}, charge() {}, writeCarrier() {},
    factory: async () => ({}) });
  hooks.bind({ user: 'Review.', operations: [], memories: memories() }, { user() {}, charge: (key) => calls.push(key) });
  for (let index = 0; index < 5; index++) await hooks['chat.params']({ sessionID: 'root' }, {});
  await assert.rejects(hooks['chat.params']({ sessionID: 'root' }, {}), { code: 'parent_generation_budget' });
  assert.equal(calls.filter((key) => key === 'parent_requests').length, 5);
});
