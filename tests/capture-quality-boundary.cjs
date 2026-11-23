class QualityBlocked extends Error {
  constructor(code) { super(code); this.code = code; }
}
function verifyIsolation(state) {
  if (!state.pure || state.plugins.length) throw new QualityBlocked('plugin_enabled');
  for (const name of ['code-review-graph', 'metabase-bridge']) {
    if (state.mcp[name]?.status !== 'disabled') throw new QualityBlocked('mcp_enabled');
  }
  if (Object.values(state.mcp).some((entry) => entry.status !== 'disabled')) throw new QualityBlocked('mcp_enabled');
  if (state.tools.some((name) => state.disabled[name] !== false)) throw new QualityBlocked('tool_enabled');
  return true;
}
function savedPrecision(rows) {
  const saved = rows.filter(({ persistence: record }) => record?.verified === true &&
    Number.isSafeInteger(record.id) && typeof record.placement === 'string' &&
    typeof record.expected === 'string' && record.expected === record.actual);
  if (saved.some((row) => row.adjudicated !== true || typeof row.correct !== 'boolean')) {
    return { status: 'blocked', numerator: null, denominator: saved.length, value: null };
  }
  const numerator = saved.filter((row) => row.correct).length;
  return { status: saved.length ? 'measured' : 'not_applicable', numerator, denominator: saved.length,
    value: saved.length ? numerator / saved.length : null };
}
function generationReply(response) {
  if (response.error || response.data?.info?.error) throw new QualityBlocked('provider_error');
  const reply = response.data;
  if (!reply || reply.info.finish !== 'stop') throw new QualityBlocked('unfinished_generation');
  if (reply.parts.some((part) => part.type === 'tool')) throw new QualityBlocked('unexpected_tool');
  return reply;
}
module.exports = { QualityBlocked, verifyIsolation, savedPrecision, generationReply };
