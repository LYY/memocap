const { providerBodyLimit } = require('./provider-transport.cjs');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function responsesTerminal(contentType) {
  const supported = /^text\/event-stream(?:\s*;|$)/i.test(contentType ?? '');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0; let line = ''; let data = []; let event = ''; let skipLF = false;
  let terminal; let invalid = supported ? null : 'unsupported_dialect';
  const frame = () => {
    if (!data.length) { event = ''; return; }
    const text = data.join('\n'); data = [];
    const label = event; event = '';
    if (text === '[DONE]') { if (!terminal) invalid ??= 'terminal_missing'; return; }
    let value;
    try { value = JSON.parse(text); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; invalid ??= 'malformed_event'; return; }
    if (!object(value) || typeof value.type !== 'string' || label && label !== value.type) { invalid ??= 'conflicting_event'; return; }
    if (!['response.completed', 'response.incomplete', 'response.failed'].includes(value.type)) {
      if (value.type === 'error') invalid ??= 'stream_error';
      return;
    }
    if (terminal) { invalid ??= 'duplicate_terminal'; return; }
    const response = value.response;
    if (!object(response) || response.status != null && response.status !== value.type.slice(9) ||
      response.incomplete_details != null && (!object(response.incomplete_details) || typeof response.incomplete_details.reason !== 'string') ||
      response.service_tier != null && typeof response.service_tier !== 'string' ||
      response.reasoning != null && (!object(response.reasoning) || response.reasoning.context != null && typeof response.reasoning.context !== 'string') ||
      value.type === 'response.failed' && (!numeric(value.sequence_number) ||
        response.error != null && (!object(response.error) || typeof response.error.message !== 'string' ||
          response.error.code != null && typeof response.error.code !== 'string'))) { invalid ??= 'malformed_terminal'; return; }
    const usage = response.usage;
    if (value.type === 'response.failed' && usage == null) {
      terminal = { dialect: 'responses', status: 'failed', usage: null }; return;
    }
    if (!object(usage) || !numeric(usage.input_tokens) || !numeric(usage.output_tokens) ||
      usage.input_tokens_details != null && !object(usage.input_tokens_details) ||
      usage.output_tokens_details != null && !object(usage.output_tokens_details)) { invalid ??= 'malformed_usage'; return; }
    const tokens = { input: usage.input_tokens, output: usage.output_tokens,
      reasoning: usage.output_tokens_details?.reasoning_tokens ?? null,
      cache_read: usage.input_tokens_details?.cached_tokens ?? null,
      cache_write: usage.input_tokens_details?.cache_write_tokens ?? null };
    if (Object.values(tokens).some((value) => value !== null && !numeric(value))) { invalid ??= 'malformed_usage'; return; }
    terminal = { dialect: 'responses', status: value.type.slice(9), usage: { tokens,
      token_states: Object.fromEntries(Object.entries(tokens).map(([key, value]) => [key, value === null ? 'absent' : 'observed'])), reported_cost: null } };
  };
  const text = (chunk) => {
    for (const character of chunk) {
      if (skipLF && character === '\n') { skipLF = false; continue; }
      skipLF = false;
      if (character !== '\r' && character !== '\n') { line += character; continue; }
      skipLF = character === '\r';
      if (!line) frame();
      else {
        const colon = line.indexOf(':'); const name = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        switch (name) { case 'data': data.push(value); break; case 'event': event = value; break; default: break; }
      }
      line = '';
    }
  };
  return {
    push(chunk) {
      bytes += chunk.byteLength;
      if (bytes > providerBodyLimit) { invalid ??= 'observation_limit'; line = ''; data = []; terminal = undefined; return; }
      if (invalid) return;
      try { text(decoder.decode(chunk, { stream: true })); }
      catch (error) { if (!(error instanceof TypeError)) throw error; invalid ??= 'malformed_utf8'; }
    },
    finish() {
      if (!invalid) {
        try { text(decoder.decode()); }
        catch (error) { if (!(error instanceof TypeError)) throw error; invalid ??= 'malformed_utf8'; }
      }
      if (line || data.length) invalid ??= 'unterminated_event';
      const result = invalid || !terminal ? { dialect: 'unknown', status: 'unknown', reason: invalid ?? 'terminal_missing', usage: null } : terminal;
      line = ''; data = []; terminal = undefined;
      return result;
    },
  };
}
module.exports = { responsesTerminal };
