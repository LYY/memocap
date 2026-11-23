const assert = require('node:assert/strict');
const { userPacket } = require('./host.cjs');
function mutationTask(host, spec) {
  const { provider, control } = host;
  for (const record of spec.records) {
    provider.responses.push({ tool: 'memocap_read', args: { id: record.id, placement: 'universal' } },
      { tool: 'memocap_maintain', get args() {
        const full = control.events.findLast((event) => event.phase === 'tool.result' && event.name === 'memocap_read').result.maintenance_read;
        return { operation: 'use', ...full, statements: [record.quote] };
      } });
  }
  provider.responses.push({ text: 'Used task complete.' }, { get text() {
    const packet = userPacket(provider);
    assert.equal(packet.stage, 'extract');
    assert.equal(packet.used.length, spec.records.length);
    const source = packet.evidence[0];
    const citations = [{ source_id: source.source_id, quote: spec.text }];
    const decision = spec.action === 'merge' ? { action: 'merge', target: packet.used[0].use_id,
      sources: packet.used.slice(1).map((entry) => entry.use_id), content: spec.text, citations } : {
      action: 'delete', target: packet.used[0].use_id, retirement_evidence_ids: [source.source_id], remaining_unique_facts: [], citations };
    return JSON.stringify({ decision });
  } }, { get text() {
    const packet = userPacket(provider);
    assert.equal(packet.stage, 'support');
    return JSON.stringify({ ...packet.binding, status: spec.support ?? 'supported' });
  } }, ...(spec.support && spec.support !== 'supported' ? [] : [{ tool: 'memocap_maintain', get args() {
    const packet = userPacket(provider);
    assert.equal(packet.stage, 'commit');
    return { operation: 'apply', proposal_id: packet.proposal_id };
  } }]), { text: '{"candidates":[]}' });
}
module.exports = { mutationTask };
