const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { inspectSelectedModel } = require('./authorized-inputs.cjs');

function fixture() {
  const request = { sourceConfig: '/readonly/selected.jsonc', providerID: 'openai-b1', modelID: 'gpt-6.1-sol',
    sdk: '@ai-sdk/openai', baseURL: 'https://provider.invalid/v1' };
  const model = { reasoning: true, limit: { context: 1000, output: 100 },
    options: { reasoningEffort: 'high', store: false }, variants: { brief: { textVerbosity: 'low' } } };
  const secret = 'SYNTHETIC_INSPECTION_CREDENTIAL';
  const source = { plugin: ['unrelated'], provider: { 'openai-b1': {
    npm: request.sdk, models: { [request.modelID]: model, unrelated: { options: { apiKey: secret } } },
    options: { baseURL: request.baseURL, apiKey: secret } } } };
  const effects = []; const opens = []; let invalid = false; let symlink = false;
  const io = new Proxy({
    lstatSync: file => ({ uid: process.getuid(), dev: 1, ino: 2,
      isFile: () => file === request.sourceConfig, isSymbolicLink: () => symlink && file === request.sourceConfig }),
    realpathSync: file => file,
    openSync(file, flags) { opens.push(file); assert.equal(file, request.sourceConfig); return 9; },
    fstatSync: () => ({ uid: process.getuid(), dev: 1, ino: 2 }),
    readFileSync(fd) { assert.equal(fd, 9); return invalid ? `{${secret}` : JSON.stringify(source); },
    closeSync(fd) { assert.equal(fd, 9); },
  }, { get(target, key) { return key in target ? target[key] : () => { effects.push(key); throw new Error(secret); }; } });
  return { request, model, source, secret, io, opens, effects,
    invalid() { invalid = true; }, symlink() { symlink = true; } };
}

test('inspection preserves selected request parameters without materializing credentials or unrelated configuration', () => {
  const f = fixture();
  const actual = inspectSelectedModel(f.request, f.io);
  assert.deepEqual(actual, { ...f.request, maxRetries: 0, metadata: f.model });
  assert.equal(JSON.stringify(actual).includes(f.secret), false);
  assert.equal(JSON.stringify(actual).includes(createHash('sha256').update(f.secret).digest('hex')), false);
  assert.deepEqual(f.opens, [f.request.sourceConfig]); assert.deepEqual(f.effects, []);
});

test('inspection exposes changed reasoning parameters instead of substituting defaults', () => {
  const f = fixture(); const before = inspectSelectedModel(f.request, f.io);
  f.model.options.reasoningEffort = 'low';
  const after = inspectSelectedModel(f.request, f.io);
  assert.equal(before.metadata.options.reasoningEffort, 'high');
  assert.equal(after.metadata.options.reasoningEffort, 'low');
  assert.notDeepEqual(after, before); assert.deepEqual(f.effects, []);
});

test('inspection never opens a referenced credential file', () => {
  const f = fixture(); f.source.provider['openai-b1'].options.apiKey = '{file:/never-open/credential}';
  const actual = inspectSelectedModel(f.request, f.io);
  assert.deepEqual(f.opens, [f.request.sourceConfig]);
  assert.equal(JSON.stringify(actual).includes('/never-open'), false); assert.deepEqual(f.effects, []);
});

test('unsupported model request options are rejected without revealing their values', () => {
  const f = fixture(); f.model.options.apiKey = f.secret;
  assert.throws(() => inspectSelectedModel(f.request, f.io), error => {
    assert.equal(error.stack.includes(f.secret), false); return error.code === 'source_model_metadata_unsupported';
  });
  assert.deepEqual(f.effects, []);
});

test('invalid JSONC is rejected without echoing the source', () => {
  const f = fixture(); f.invalid();
  assert.throws(() => inspectSelectedModel(f.request, f.io), error => {
    assert.equal(error.stack.includes(f.secret), false); return error.code === 'source_config_invalid';
  });
  assert.deepEqual(f.effects, []);
});

test('symlinked configuration is rejected before the source is opened', () => {
  const f = fixture(); f.symlink();
  assert.throws(() => inspectSelectedModel(f.request, f.io), { code: 'canonical_input_paths_required' });
  assert.deepEqual(f.opens, []); assert.deepEqual(f.effects, []);
});
