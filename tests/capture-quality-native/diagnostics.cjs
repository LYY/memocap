const { isAuditedPreload } = require('./preload-decision.cjs');

function diagnostics(observation, expectedIdentities) {
  const result = observation.result;
  const data = result?.data;
  const origins = data?.plugin_origins;
  const entries = Array.isArray(origins) ? origins : [];
  const mcp = data?.mcp;
  const knownMcp = mcp !== null && typeof mcp === 'object' && !Array.isArray(mcp);
  const knownOrigins = Array.isArray(origins);
  const statuses = observation.mcpStatus?.data;
  const knownStatuses = observation.mcpStatus?.error === undefined && statuses !== null
    && typeof statuses === 'object' && !Array.isArray(statuses);
  const originEntries = entries.map((entry) => ({
    scope: ['local', 'global'].includes(entry?.scope) ? entry.scope : 'unknown',
    task_owned: expectedIdentities.includes(Array.isArray(entry?.spec) ? entry.spec[0] : entry?.spec),
    source_category: entry?.source === 'OPENCODE_CONFIG_CONTENT' ? 'task_config_content' : 'other_or_unknown',
  }));
  const pluginsMatch = Array.isArray(data?.plugin) && data.plugin.length === expectedIdentities.length
    && data.plugin.every((spec, index) => typeof spec === 'string' && spec === expectedIdentities[index]);
  const originsMatch = knownOrigins && entries.length === expectedIdentities.length
    && originEntries.every((entry, index) => entry.task_owned && entry.scope === 'local'
      && entry.source_category === 'task_config_content' && entries[index].spec === expectedIdentities[index]);
  const publicMatch = observation.status === 200 && !result?.error && !observation.exception && pluginsMatch
    && knownMcp && knownStatuses && Object.keys(mcp).length === 0 && Object.keys(statuses).length === 0;
  const isolation = !publicMatch ? 'unknown' : originsMatch ? 'declared_match_only'
    : origins === undefined && isAuditedPreload(observation.preload, expectedIdentities) ? 'audited_preload_and_public_match' : 'unknown';
  return {
    http_status: Number.isInteger(observation.status) ? observation.status : null,
    content_type: ['application/json', 'text/plain', 'text/html'].includes(observation.contentType)
      ? observation.contentType : 'unknown',
    bytes: Number.isSafeInteger(observation.bytes) && observation.bytes >= 0 ? observation.bytes : null,
    data_present: result != null && Object.hasOwn(result, 'data'),
    error_present: result != null && Object.hasOwn(result, 'error'),
    exception_class: observation.exception instanceof TypeError ? 'TypeError'
      : observation.exception instanceof SyntaxError ? 'SyntaxError'
      : observation.exception instanceof Error ? 'Error' : observation.exception === undefined ? null : 'unknown',
    origins: { presence: origins === undefined ? 'unavailable' : 'available',
      type: Array.isArray(origins) ? 'array' : origins === null ? 'null' : typeof origins,
      count: knownOrigins ? entries.length : null, entries: originEntries },
    mcp: { presence: knownMcp ? 'available' : 'unavailable', count: knownMcp ? Object.keys(mcp).length : null,
      status_presence: knownStatuses ? 'available' : 'unavailable',
      statuses: knownStatuses ? Object.values(statuses).map((entry) =>
        ['connected', 'disabled', 'failed', 'needs_auth', 'needs_client_registration'].includes(entry?.status)
          ? entry.status : 'unknown') : null },
    isolation,
  };
}

module.exports = { diagnostics };
