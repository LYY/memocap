import { isSupportedHost } from '../../lib/opencode-host.js';
import { sourceProfile } from './sources/profile.js';
import { readFrame } from './sources/read.js';
import { sourceBundles } from './sources/sections.js';
import { selectBundles } from './sources/selection.js';
import { byteSize, hash, identifier, normalize, quoteSpan, resolveQuote, retainSource, secretSafe, skip, truncated } from './sources/value.js';

export { quoteSpan, resolveQuote, selectBundles, sourceBundles, sourceProfile };

export function adaptSource(observation) {
  if (!observation || typeof observation !== 'object') return skip('identity');
  if (!secretSafe(observation)) return skip('secret_or_unicode');
  const { host_version: version, user_id: user, observed_at: at, message, part } = observation;
  if (!isSupportedHost(version) || !identifier(user) || !identifier(message?.id) ||
      !identifier(part?.id) || part.synthetic || part.ignored || part.metadata?.memocap ||
      !Number.isSafeInteger(at) || at <= 0 || (part.messageID !== undefined && part.messageID !== message.id)) return skip('identity');
  let frame;
  let tool;
  switch (message.role) {
    case 'user':
      if (message.id !== user || part.type !== 'text' || typeof part.text !== 'string') return skip('identity');
      frame = { text: normalize(part.text), locator: message.id, kind: 'user_statement',
        outcome: { type: 'user_statement' }, authority: 'user_statement' };
      break;
    case 'assistant': {
      if (message.parentID !== user || part.type !== 'tool' || !identifier(part.callID) ||
          !['read', 'bash'].includes(part.tool)) return skip('unverified_shape');
      const state = part.state;
      if (!Number.isSafeInteger(state?.time?.start) || !Number.isSafeInteger(state.time.end) ||
          state.time.start > state.time.end || state.time.end > at) return skip('incomplete');
      tool = { call_id: part.callID, tool_id: part.tool, tool_status: state.status };
      switch (state.status) {
        case 'error':
          if (typeof state.error !== 'string' || !state.error || truncated(state.error)) return skip('unverified_shape');
          frame = { text: normalize(state.error), locator: `${message.id}/${part.id}`, kind: 'tool_error',
            outcome: { type: 'reported_failure' }, authority: 'reported_failure' };
          break;
        case 'completed':
          switch (part.tool) {
            case 'read': frame = readFrame(state); break;
            case 'bash':
              if (typeof state.input?.command !== 'string' || typeof state.output !== 'string' ||
                  !Number.isSafeInteger(state.metadata?.exit) || state.metadata.truncated !== false ||
                  typeof state.metadata.output !== 'string' || truncated(state.output)) return skip('incomplete');
              frame = { text: normalize(state.output), locator: `${message.id}/${part.id}`,
                invocation: { command: normalize(state.input.command) }, kind: 'command_result',
                outcome: { type: 'process_exit', exit_code: state.metadata.exit }, authority: 'observed_result' };
              break;
            default: return skip('unverified_shape');
          }
          break;
        case 'pending': case 'running': return skip('incomplete');
        default: return skip('unverified_shape');
      }
      break;
    }
    default: return skip('identity');
  }
  if (!frame) return skip('unverified_shape');
  const { text, locator, line_range, ...facts } = frame;
  if (!text || byteSize(observation) > sourceProfile.max_source_bytes) return skip('source_budget');
  const content_hash = hash(text);
  return Object.freeze({ status: 'source', source: retainSource({
    source_id: part.id, user_id: user, message_id: message.id, part_id: part.id, ...tool, ...facts,
    host_version: version, completeness: 'full', text, content_hash,
    pointer: { type: frame.kind === 'file_content' ? 'file' : 'message_part', locator, observed_at: at,
      content_hash, hash_scope: 'observed_text', ...(line_range ? { line_range } : {}) },
    span: { start: 0, end: [...text].length }, context_dependencies: [],
  }) });
}
