const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const bool = (value) => typeof value === 'boolean';
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const interleavedFields = ['reasoning', 'reasoning_content', 'reasoning_text'];
const modalities = ['text', 'audio', 'image', 'video', 'pdf'];

class ModelProfileBlocked extends Error {
  constructor() { super('model_profile_unsupported'); this.code = 'model_profile_unsupported'; }
}
function requireModel(condition) { if (!condition) throw new ModelProfileBlocked(); }
function safeText(value) {
  return typeof value === 'string' && value.length <= 256 && value.isWellFormed()
    && [...value].every((character) => character.codePointAt(0) >= 32
      && (character.codePointAt(0) < 127 || character.codePointAt(0) > 159)) && !/[{}]/u.test(value)
    && !/(?:sk-|bearer\s|api[_-]?key|secret|token[_-]|password)/iu.test(value);
}
function keys(value, allowed, required = []) {
  return object(value) && Object.keys(value).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key));
}
function prices(value, extended = true) {
  const fields = ['input', 'output', 'cache_read', 'cache_write'];
  requireModel(object(value) && ['input', 'output'].every((key) => Object.hasOwn(value, key)));
  const output = {};
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) continue;
    requireModel(finite(value[key])); output[key] = value[key];
  }
  if (extended && Object.hasOwn(value, 'context_over_200k')) output.context_over_200k = prices(value.context_over_200k, false);
  return output;
}
function reasoningOption(value) {
  requireModel(object(value));
  switch (value.type) {
    case 'effort':
      requireModel(keys(value, ['type', 'values'], ['values']) && Array.isArray(value.values)
        && value.values.every((effort) => effort === null || efforts.includes(effort)));
      return { type: value.type, values: [...value.values] };
    case 'toggle':
      requireModel(keys(value, ['type'])); return { type: value.type };
    case 'budget_tokens':
      requireModel(keys(value, ['type', 'min', 'max'])
        && Object.keys(value).every((key) => key === 'type' || finite(value[key])));
      return { ...value };
    default: throw new ModelProfileBlocked();
  }
}
function requestOptions(value, variant = false) {
  requireModel(object(value));
  const output = {};
  for (const key of Object.keys(value)) {
    const option = value[key];
    switch (key) {
      case 'reasoningEffort': requireModel(efforts.includes(option)); break;
      case 'reasoningSummary': requireModel(['auto', 'concise', 'detailed'].includes(option)); break;
      case 'textVerbosity': requireModel(['low', 'medium', 'high'].includes(option)); break;
      case 'parallelToolCalls': case 'store': requireModel(bool(option)); break;
      case 'disabled': requireModel(variant && bool(option)); break;
      case 'include':
        requireModel(Array.isArray(option) && option.every((item) => item === 'reasoning.encrypted_content')); break;
      default: throw new ModelProfileBlocked();
    }
    Object.defineProperty(output, key, { value: Array.isArray(option) ? [...option] : option, enumerable: true });
  }
  return output;
}

function projectModel(model) {
  requireModel(object(model));
  const output = {};
  const fields = ['id', 'name', 'family', 'release_date', 'attachment', 'reasoning', 'reasoning_options',
    'temperature', 'tool_call', 'interleaved', 'cost', 'limit', 'modalities', 'experimental', 'status',
    'provider', 'options', 'headers', 'variants'];
  for (const key of fields) {
    if (!Object.hasOwn(model, key)) continue;
    const value = model[key];
    switch (key) {
      case 'id': requireModel(value === 'gpt-6.1-sol'); output[key] = value; break;
      case 'name': case 'family': case 'release_date':
        requireModel(safeText(value)); output[key] = value; break;
      case 'attachment': case 'reasoning': case 'temperature': case 'tool_call': case 'experimental':
        requireModel(bool(value)); output[key] = value; break;
      case 'status':
        requireModel(['alpha', 'beta', 'deprecated', 'active'].includes(value)); output[key] = value; break;
      case 'reasoning_options':
        requireModel(Array.isArray(value)); output[key] = value.map(reasoningOption); break;
      case 'interleaved':
        requireModel(bool(value) || interleavedFields.includes(value)
          || keys(value, ['field'], ['field']) && interleavedFields.includes(value.field));
        output[key] = object(value) ? { ...value } : value; break;
      case 'cost':
        output[key] = prices(value); break;
      case 'limit':
        requireModel(keys(value, ['context', 'input', 'output'], ['context', 'output'])
          && Object.values(value).every(finite)); output[key] = { ...value }; break;
      case 'modalities':
        requireModel(keys(value, ['input', 'output']) && Object.values(value).every((items) =>
          Array.isArray(items) && items.every((item) => modalities.includes(item))));
        output[key] = Object.fromEntries(Object.entries(value).map(([direction, items]) => [direction, [...items]])); break;
      case 'options': output[key] = requestOptions(value); break;
      case 'variants':
        requireModel(object(value));
        output[key] = Object.fromEntries(Object.keys(value).map((name) => {
          requireModel(safeText(name) && /^[a-zA-Z0-9_-]{1,64}$/u.test(name));
          return [name, requestOptions(value[name], true)];
        })); break;
      case 'headers': requireModel(keys(value, [])); output[key] = {}; break;
      case 'provider': throw new ModelProfileBlocked();
      default: throw new ModelProfileBlocked();
    }
  }
  return output;
}

module.exports = { projectModel, ModelProfileBlocked };
