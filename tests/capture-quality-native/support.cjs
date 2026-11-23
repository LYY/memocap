const { CanaryBlocked } = require('./entry.cjs');
const { digest } = require('./projection.cjs');

function materialize(challenge, contract, packet) {
  const citations = (names) => names.map((name) => {
    const binding = contract.bindings[name];
    const source = packet.sources.find((item) => item.content_hash === binding.content_hash &&
      typeof item.text === 'string' && digest(item.text) === binding.content_hash &&
      [...item.text].slice(binding.span.start, binding.span.end).join('') === binding.quote);
    if (!source || source.completeness !== 'full' || !packet.bundles.some((bundle) =>
      bundle.source_id === source.source_id && bundle.user_id === source.user_id && bundle.units.some((unit) =>
        unit.content_hash === source.content_hash && unit.span.start <= binding.span.start && unit.span.end >= binding.span.end))) {
      throw new CanaryBlocked('actual_selected_source_unavailable');
    }
    return { source_id: source.source_id, content_hash: source.content_hash, span: binding.span, quote: binding.quote };
  });
  return { candidates: [{ kind: challenge.candidate.kind, statements: challenge.candidate.statements.map((statement) =>
    ({ text: statement.text, citations: citations(statement.citations) })) }] };
}

function supportSchedule(tuning, contract) {
  return contract.counterfactuals.map((challenge) => {
    const original = tuning.capture.find((entry) => entry.id === challenge.original_case);
    const tools = original.turns.flatMap((turn) => turn.tools);
    const feasible = tools.length > 0 && tools.every((tool) => tool.tool === 'read');
    return { challenge, original, status: feasible ? 'deliverable_read_carrier' : 'seam_not_reached',
      missing: feasible ? null : 'executable_original_tool_operation', support_dispatches: 0, writes: 0, quality_credit: false };
  });
}

module.exports = { materialize, supportSchedule };
