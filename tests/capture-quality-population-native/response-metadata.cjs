const { requireStage } = require('./value.cjs');
const { usage } = require('../capture-quality-native/projection.cjs');
function metadata(info, types = null) {
  const category = info.error?.name;
  return { message: info.id ?? null, session: info.sessionID ?? null, finish: info.finish ?? null,
    error_category: info.error == null ? null : ['ProviderAuthError', 'UnknownError', 'MessageOutputLengthError',
      'MessageAbortedError', 'APIError'].includes(category) ? category : 'unknown',
    created: info.time?.created ?? null, completed: info.time?.completed ?? null, part_types: types };
}
function completion(info, types = null) {
  return { source: 'observed_completion', dispatch_id: null, session: info.sessionID, message: info.id,
    usage: usage(info), metadata: metadata(info, types) };
}
async function reply(response) {
  const text = response.data?.parts?.filter((part) => part.type === 'text').map((part) => part.text).join('');
  requireStage(typeof text === 'string' && text.length <= 16000, 'child_response_budget');
  requireStage((await import('../../plugin/capture/screen.js')).clean(text), 'secret_model_response');
  return { text, usage: usage(response.data.info), message: response.data.info.id, source: 'sdk_returned',
    dispatch_id: null, metadata: metadata(response.data.info, response.data.parts.map((part) => part.type)) };
}
function observeChild(record, child, actual) {
  const { info, part } = actual.properties ?? {};
  if (actual.type === 'message.part.updated' && part && !child.completions.has(part.messageID)) {
    if (child.parts.size < 24 || child.parts.has(part.id)) child.parts.set(part.id, { message: part.messageID, type: part.type });
    else child.partsIncomplete = true;
  }
  if (actual.type !== 'message.updated' || info?.role !== 'assistant' || info.time?.completed === undefined || child.completions.has(info.id)) return;
  if (child.completions.size >= 16) return;
  child.completions.add(info.id);
  const parts = [...child.parts].filter(([, part]) => part.message === info.id);
  record('model.completion', completion(info, parts.length && !child.partsIncomplete ? [...new Set(parts.map(([, part]) => part.type))] : null), child);
  for (const [id] of parts) child.parts.delete(id);
}
module.exports = { completion, reply, observeChild };
