const { createHash } = require('node:crypto');
const { validateInventory, validateReceipt, validateRead } = require('../../plugin/protocol.js');
const { CanaryBlocked } = require('./entry.cjs');
const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function usage(info) {
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const created = finite(info.time?.created); const completed = finite(info.time?.completed);
  return { tokens: { input: finite(info.tokens?.input), output: finite(info.tokens?.output),
    reasoning: finite(info.tokens?.reasoning), cache_read: finite(info.tokens?.cache?.read),
    cache_write: finite(info.tokens?.cache?.write) }, reported_cost: finite(info.cost), cost: null,
    latency_ms: created !== null && completed !== null && completed >= created ? completed - created : null };
}

function receipt(value) {
  return { status: value.status ?? null, operation: value.operation ?? null, operation_id: value.operation_id ?? null,
    truncated: value.truncated ?? null,
    returned_ids: value.returned_ids ?? [], searched_placements: value.searched_placements ?? [],
    error_code: value.error?.code ?? null, error_present: value.error != null,
    records: (value.results ?? []).filter((entry) => entry.memory).map(({ memory, completeness }) => ({ id: memory.id,
      placement: memory.placement, content_hash: digest(memory.content), tags_hash: digest(memory.tags ?? ''),
      completeness: completeness ?? (value.operation === 'read' && value.truncated === false ? 'full' : null),
      content: memory.content.length <= 6000 ? memory.content : null })),
    ...(value.readback ? { readback: receipt(value.readback) } : {}) };
}

function writeReceipt(value, { command, caller }) {
  validateReceipt(value);
  if (value.backend !== 'local' || value.error || value.origin !== 'cli' || caller.actor !== 'plugin' ||
      !caller.session_id || !caller.message_id || value.caller?.actor !== caller.actor ||
      value.caller.session_id !== caller.session_id || value.caller.message_id !== caller.message_id) {
    throw new CanaryBlocked('native_write_receipt_identity');
  }
  switch (command) {
    case 'remember': {
      validateInventory(value);
      const memory = value.results[0]?.memory;
      if (value.operation !== 'remember' || !['inserted', 'updated'].includes(value.status) || value.results.length !== 1 ||
          typeof memory?.content !== 'string' || typeof memory.tags !== 'string' || value.searched_placements?.length !== 1 ||
          value.searched_placements[0] !== memory.placement || !value.targets.some((target) => target.placements.includes(memory.placement))) {
        throw new CanaryBlocked('native_write_receipt_identity');
      }
      break;
    }
    case 'organize':
      if (value.operation !== 'organize_maintain' || value.status !== 'ok' || value.outcome !== 'committed' ||
          !Array.isArray(value.organization?.records) || !Array.isArray(value.organization.deleted)) {
        throw new CanaryBlocked('native_write_receipt_identity');
      }
      break;
    default: throw new CanaryBlocked('native_write_receipt_identity');
  }
  return receipt(value);
}

function matchesReadback(checked, record) {
  const full = checked?.records?.[0];
  return Boolean(record && typeof checked?.operation_id === 'string' && checked.operation_id.length > 0 &&
    checked.operation === 'read' && checked.status === 'ok' && checked.error_code === null &&
    checked.error_present === false && checked.truncated === false && checked.records.length === 1 && checked.returned_ids.length === 1 &&
    checked.returned_ids[0] === record.id && full.completeness === 'full' && full.id === record.id &&
    full.placement === record.placement && full.content_hash === record.content_hash && full.tags_hash === record.tags_hash);
}

function readbackReceipt(value, record) {
  const full = validateRead(value, record);
  if (value.error || typeof full.results[0].memory.tags !== 'string') throw new CanaryBlocked('independent_readback_invalid');
  const projected = receipt(full);
  if (!matchesReadback(projected, record)) throw new CanaryBlocked('independent_readback_mismatch');
  return projected;
}

function maintenance(value) {
  const result = { kind: value.phase, stage: value.stage ?? null, parentID: value.parentID,
    user_id: value.user_id, review_id: value.review_id, origin_fingerprint: value.origin_fingerprint,
    source_fingerprint: value.source_fingerprint, observation_hash: digest(value) };
  result.proposal_id = value.proposal?.proposal_id ?? null;
  result.action = value.proposal?.action ?? value.validated?.decision?.action ?? value.candidate?.decision?.action ?? null;
  result.permission = value.permission ? { action: value.permission.action, granted: value.permission.granted } : null;
  for (const key of ['proposal_id', 'decision_fingerprint', 'evidence_fingerprint', 'reason', 'status', 'outcome']) {
    if (typeof value[key] === 'string' && /^[a-zA-Z0-9_:.-]{1,160}$/.test(value[key])) result[key] = value[key];
  }
  for (const key of ['candidate', 'validated', 'assessment', 'proposal', 'raw_text']) {
    if (value[key] !== undefined) { result[`${key}_hash`] = digest(value[key]); result[key] = value[key]; }
  }
  return result;
}

function joinReadRoute({ events, messages, expected, session, carrier, bindings }) {
  const key = bindings?.roots?.[session];
  const review = bindings?.reviews?.[key];
  const currentUser = review?.session === session ? review.user : null;
  const child = (id, stage) => {
    const bound = bindings?.sessions?.[id];
    return bound?.root === session && bound.review === key && bound.stage === stage;
  };
  const user = messages.find((message) => message.info.role === 'user' &&
    message.info.id === currentUser && message.info.sessionID === session);
  const completed = messages.some((message) => message.info.role === 'assistant' &&
    message.info.sessionID === session && user && message.info.parentID === user.info.id &&
    message.info.finish === 'stop' && !message.info.error);
  const source = events.find((event) => event.kind === 'capture.packet' && event.root === session &&
    child(event.session, 'extract') && user && event.packet.current_user_id === user.info.id &&
    event.packet.sources.some((item) => item.kind === 'file_content' && item.tool_id === 'read' &&
      item.user_id === user.info.id && item.completeness === 'full' && item.text === expected &&
      item.content_hash === digest(expected) && item.pointer.locator === carrier &&
      event.packet.bundles.some((bundle) => bundle.source_id === item.source_id && bundle.user_id === user.info.id &&
        bundle.units.some((unit) => unit.content_hash === item.content_hash && unit.text === expected &&
          unit.span.start === 0 && unit.span.end === Array.from(expected).length)) &&
      messages.some((message) => message.info.id === item.message_id && message.info.sessionID === session &&
        message.info.parentID === item.user_id && message.parts.some((part) => part.id === item.part_id &&
          part.type === 'tool' && part.callID === item.call_id && part.tool === 'read' &&
          part.state.status === 'completed' && part.state.input.filePath === carrier))));
  const tool = events.find((event) => event.kind === 'tool.receipt' && event.root === session &&
    child(event.session, 'commit') && typeof event.message === 'string' && event.message.length > 0 &&
    event.tool === 'memocap_remember' && event.receipt.status === 'inserted');
  const asks = events.filter((event) => event.kind === 'native.ask' && event.session === tool?.session &&
    event.message === tool?.message && event.permission === 'memocap_remember');
  const ask = asks.length === 1 && asks[0].outcome === 'resolved' ? asks[0] : null;
  const invocations = events.filter((event) => event.kind === 'native.tool_before' && event.session === tool?.session &&
    event.tool === 'memocap_remember' && typeof event.call === 'string' && event.call.length > 0 &&
    events.some((part) => part.kind === 'native.event' && part.type === 'message.part.updated' &&
      part.session === event.session && part.message === tool.message && part.call === event.call &&
      part.tool === 'memocap_remember' && part.part && part.status === 'completed'));
  const invocation = invocations.length === 1 ? invocations[0] : null;
  const operation = events.find((event) => event.kind === 'native.receipt' && tool?.receipt.operation_id &&
    event.receipt.operation_id === tool.receipt.operation_id && event.command === 'remember' && event.exit_code === 0 &&
    event.session === tool.session && event.message === tool.message);
  const readback = events.find((event) => event.kind === 'independent.readback' &&
    event.write_operation_id === tool?.receipt.operation_id && event.exit_code === 0);
  const record = operation?.receipt.records?.[0];
  const checked = readback?.receipt.records?.[0];
  const verified = Boolean(completed && source && invocation && ask && operation && record && checked &&
    operation.receipt.operation === 'remember' && operation.receipt.status === 'inserted' &&
    operation.receipt.error_present === false && operation.receipt.records.length === 1 &&
    operation.receipt.returned_ids.length === 1 && operation.receipt.returned_ids[0] === record.id &&
    tool.receipt.operation === 'remember' && tool.receipt.records.length === 1 && tool.receipt.error_present === false &&
    tool.receipt.returned_ids.length === 1 && tool.receipt.returned_ids[0] === record.id &&
    tool.receipt.records[0].id === record.id && tool.receipt.records[0].placement === record.placement &&
    tool.receipt.records[0].content_hash === record.content_hash && tool.receipt.records[0].tags_hash === record.tags_hash &&
    matchesReadback(tool.receipt.readback, record) && matchesReadback(readback.receipt, record));
  return { status: verified ? 'native_join_verified_adjudication_pending' : 'seam_not_reached',
    user_id: user?.info.id ?? null, normal_completion: completed, selected_source: source ? 'actual' : null,
    ask: ask?.outcome ?? null, call_id: invocation?.call ?? null, operation_id: tool?.receipt.operation_id ?? null,
    independent_readback: checked ?? null, quality_credit: false,
    missing: [!completed && 'normal_completion', !source && 'actual_selected_source', !invocation && 'actual_commit_tool_event', !ask && 'real_native_ask',
      !operation && 'native_write_receipt', !checked && 'independent_readback',
      !verified && record && checked && 'identity_or_readback_mismatch'].filter(Boolean) };
}

module.exports = { digest, receipt, maintenance, joinReadRoute, usage, writeReceipt, readbackReceipt, matchesReadback };
