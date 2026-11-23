const { matchesInput } = require('./carrier.cjs');
const { requireStage, hash, identifier, size } = require('./value.cjs');

async function createCustody(session, carrier) {
  const { adaptSource } = await import('../../plugin/capture/sources.js');
  const rows = [];
  const seen = new Set();
  let current;
  let index;
  let completed = false;
  function unique(value) {
    requireStage(identifier(value) && !seen.has(value), 'native_identity_reused_or_malformed');
    seen.add(value);
  }
  function user(value, expected) {
    const { message, parts } = value;
    requireStage(!current || completed, 'previous_root_incomplete');
    requireStage(message?.sessionID === session.sessionID && message.role === 'user' && parts?.length === 1 &&
      parts[0].type === 'text' && parts[0].text === expected.user && parts[0].sessionID === session.sessionID &&
      parts[0].messageID === message.id && !parts[0].synthetic && !parts[0].ignored, 'native_user_mismatch');
    unique(message.id); unique(parts[0].id);
    current = message.id; index = expected.turn; completed = false;
    rows.push({ logical: `u${index + 1}`, text_hash: hash(expected.user), actual: { session: session.sessionID, user: current, part: parts[0].id } });
  }
  function tool(value) {
    const step = carrier.pending();
    requireStage(current && !completed && step && size(value) <= 16384, 'unprepared_or_oversize_source_event');
    const { message, part } = value;
    requireStage(value.userID === current && message?.parentID === current && message.role === 'assistant' &&
      message.sessionID === session.sessionID && part?.sessionID === session.sessionID && part.messageID === message.id &&
      part.type === 'tool' && part.tool === step.nativeTool && matchesInput(part.tool, step.input, part.state?.input), 'native_source_identity');
    requireStage(identifier(message.id) && message.id !== current, 'native_message_identity');
    unique(part.id); unique(part.callID);
    const state = part.state;
    requireStage(state?.status === (step.failure ? 'error' : 'completed'), 'native_source_status');
    let adapted;
    if (step.partial) {
      requireStage(state.input.offset === 10 && state.metadata?.display?.lineStart === 10 &&
        state.metadata.display.text === step.text && state.output.includes(`10: ${step.text}`), 'partial_carrier_mismatch');
      adapted = adaptSource({ host_version: session.version, user_id: current, observed_at: Date.now(), message, part });
      requireStage(adapted.status !== 'source', 'partial_promoted_to_full');
    } else {
      adapted = adaptSource({ host_version: session.version, user_id: current, observed_at: Date.now(), message, part });
      requireStage(adapted.status === 'source' && adapted.source.text === step.text && adapted.source.content_hash === step.source_hash,
        'native_source_bytes_or_framing');
    }
    const accepted = carrier.accept();
    rows.push({ logical: accepted.tool?.id ?? `adapter-operation:${rows.length}`, turn: index + 1,
      origin: accepted.tool ? 'original-tool' : 'declared-finite-operation', original_path: accepted.tool?.path ?? null,
      original_output_hash: accepted.tool ? hash(accepted.tool.output) : null,
      source_hash: step.source_hash, raw_source_hash: step.raw_source_hash,
      completeness: step.partial ? 'fragment' : 'full', adapter_status: adapted.status,
      actual: { session: session.sessionID, user: current, message: message.id, part: part.id, call: part.callID, tool: part.tool } });
  }
  function complete(info) {
    requireStage(current && !completed && info?.sessionID === session.sessionID && info.parentID === current &&
      identifier(info.id) && info.id !== current && info.role === 'assistant' && info.finish === 'stop' && !info.error &&
      Number.isSafeInteger(info.time?.completed) && info.time.completed > 0, 'native_completion_missing');
    carrier.complete(index); completed = true;
    rows.push({ logical: `a${index + 1}`, actual: { session: session.sessionID, user: current, message: info.id }, completion: 'observed_stop' });
  }
  return { user, tool, complete, rows: () => structuredClone(rows), current: () => current,
    finished: () => completed };
}
module.exports = { createCustody };
