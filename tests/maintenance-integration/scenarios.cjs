const assert = require('node:assert/strict');
const { userPacket } = require('./host.cjs');
const revised = 'For local fixture, route is now /v2; unique timeout remains 7.';
function usedTask(host, options = {}) {
  const { provider, control } = host;
  provider.responses.push({ tool: 'memocap_read', args: { id: 1, placement: 'universal' } },
    { tool: 'memocap_maintain', get args() {
      const read = control.events.findLast((event) => event.phase === 'tool.result' && event.name === 'memocap_read').result.maintenance_read;
      assert.ok(read);
      return { operation: 'use', ...read, statements: ['route is /v1'] };
    } }, ...(options.observations ?? []), { text: 'Fixture task completed.' },
    ...(options.unknown ? [] : [{ get text() {
      const data = userPacket(provider);
      assert.equal(data.stage, 'extract');
      if (options.action === 'keep') return JSON.stringify({ decision: { action: 'keep', target: data.used[0].use_id } });
      const source = data.evidence[0];
      return JSON.stringify({ decision: { action: 'update', target: data.used[0].use_id, content: revised,
      citations: [{ source_id: source.source_id, quote: revised }] } });
    } }, ...(options.action === 'keep' ? [] : [{ get text() {
      const data = userPacket(provider);
      assert.equal(data.stage, 'support');
      return JSON.stringify({ ...data.binding, status: options.support ?? 'supported' });
    } }, ...(options.commit === false || options.support && options.support !== 'supported' ? [] : [{ tool: 'memocap_maintain', get args() {
      const data = userPacket(provider);
      assert.equal(data.stage, 'commit');
      return { operation: 'apply', proposal_id: data.proposal_id };
    } }])])]), { text: '{"candidates":[]}' });
}
const review = (host, parent) => host.control.wait((event) => event.phase === 'maintenance.review' && event.parentID === parent.id);
const spawns = (host) => host.control.events.filter((event) => event.phase === 'native.spawn' && event.args.includes('maintain'));
const content = (host) => host.cli(['organize', 'read'], { keys: [{ id: 1, placement: 'universal' }] }).organization.records[0].snapshot;
module.exports = { usedTask, revised, review, spawns, content };
