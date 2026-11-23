const assert = require('node:assert/strict');
const test = require('node:test');
const { toy, digest } = require('./evaluation-fixture.cjs');
const { createEvaluation } = require('./population.cjs');
const { fakeHost } = require('./fake-host.cjs');
const { runCase } = require('./adapter.cjs');
function evaluation(explicit = true) {
  const input = toy(); const raw = JSON.parse(input.input_utf8);
  raw.maintenance[0].participants = [{ key: 'comparison', body: 'Other body.', placement: 'repository:toy' }];
  if (explicit) raw.maintenance[0].adoption_keys = ['comparison', 'toy-key'];
  input.input_utf8 = JSON.stringify(raw); input.input_sha256 = digest(input.input_utf8);
  input.mapping.tuning_sha256 = input.input_sha256; input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  return createEvaluation(input);
}
async function execute(mutate = () => {}, explicit = true) {
  const host = fakeHost(); const deliver = host.deliver;
  host.deliver = (packet, boundary) => {
    const events = [];
    return deliver(packet, { ...boundary, record(event) { events.push(structuredClone(event)); },
      async complete(info) { mutate(events); events.forEach(boundary.record); await boundary.complete(info); } });
  };
  const report = await runCase('toy-update', { population: evaluation(explicit), host, budget: { mode: 'offline' } });
  return { report, host };
}
test('public injected adapter observes both explicit adoptions and no genuine effects', async () => {
  const { report, host } = await execute();
  assert.equal(report.status, 'wired');
  assert.deepEqual(report.trace.events.filter((event) => event.kind === 'memory.use').map((event) => event.id), [101, 102]);
  assert.deepEqual(host.packets[0].memories.map((memory) => Boolean(memory.declaration)), [true, true]);
  assert.equal(host.stats.provider_requests, 0); assert.equal(host.stats.native_processes, 0);
  assert.equal(host.stats.closed, 1); assert.equal(report.quality_credit, false);
});
test('undeclared comparison remains read-only with primary adoption', async () => {
  const { report, host } = await execute(() => {}, false);
  assert.equal(report.status, 'wired');
  assert.deepEqual(host.packets[0].memories.map((memory) => Boolean(memory.declaration)), [true, false]);
});
const corruptions = {
  missing(events) { events.splice(events.findLastIndex((event) => event.kind === 'memory.use'), 1); },
  extra(events) { events.push({ ...events.find((event) => event.kind === 'memory.use'), use_id: 'extra' }); },
  wrongRecord(events) { events.find((event) => event.kind === 'memory.use').id = 999; },
  swapped(events) { const uses = events.filter((event) => event.kind === 'memory.use'); [uses[0].receipt_id, uses[1].receipt_id] = [uses[1].receipt_id, uses[0].receipt_id]; },
  hash(events) { events.find((event) => event.kind === 'memory.use').content_hash = 'stale'; },
  placement(events) { events.find((event) => event.kind === 'memory.use').placement = 'universal'; },
  receipt(events) { events.find((event) => event.kind === 'memory.use').receipt_id = 'stale'; },
  duplicate(events) { const uses = events.filter((event) => event.kind === 'memory.use'); uses[1].use_id = uses[0].use_id; },
  early(events) { const index = events.findIndex((event) => event.kind === 'memory.use'); events.unshift(...events.splice(index, 1)); },
  staleRead(events) { events.find((event) => event.kind === 'memory.read').record.content = 'Old body.'; },
};
for (const [label, mutate] of Object.entries(corruptions)) test(`adapter rejects ${label} actual adoption evidence`, async () => {
  const { report } = await execute(mutate);
  assert.equal(report.status, 'blocked'); assert.match(report.reason, /^native_(adoption|memory_read)_missing$/);
});
