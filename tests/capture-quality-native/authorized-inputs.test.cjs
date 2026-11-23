const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { prepareAuthorizedInputs, main } = require('./authorized-inputs.cjs');
const { validateProfile } = require('./approval.cjs');
const secret = 'SYNTHETIC_NOT_A_REAL_CREDENTIAL';
const digest = createHash('sha256').update(secret).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'native-inputs-offline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = { sourceConfig: path.join(root, 'source.jsonc'), inputDirectory: path.join(root, 'inputs'),
    canaryRoot: path.join(root, 'canary'), providerID: 'openai-b1', modelID: 'gpt-6.1-sol',
    sdk: '@ai-sdk/openai', baseURL: 'https://provider.invalid/v1',
    providerDestinations: ['https://provider.invalid/v1/responses'] };
  const source = { plugin: ['unrelated'], mcp: { unrelated: {} }, provider: { other: {}, 'openai-b1': {
    npm: request.sdk, models: { other: {}, 'gpt-6.1-sol': { reasoning: true, limit: { context: 1000, output: 100 } } },
    options: { baseURL: request.baseURL, apiKey: secret } } } };
  const save = () => fs.writeFileSync(request.sourceConfig, `// synthetic fixture\n${JSON.stringify(source)}`, { mode: 0o600 });
  save();
  const gate = () => ({ ...request, providerDestinations: [...request.providerDestinations], authorized: true,
    mode: 'credential-materialization-only', consent: 'fresh-explicit-credential-materialization' });
  return { root, request, source, save, gate };
}

test('declared model behavior survives preparation while host-ignored metadata disappears', (t) => {
  const f = fixture(t);
  const model = { id: f.request.modelID, reasoning_options: [{ type: 'effort', values: [null, 'high'] }],
    modalities: { input: ['text', 'image'], output: ['text'] }, variants: { high: { reasoningEffort: 'high', disabled: false } },
    limit: { context: 1000, output: 0 }, knowledge: { ignored: '{file:/never-open}' } };
  f.source.provider['openai-b1'].models[f.request.modelID] = model; f.save();
  const result = prepareAuthorizedInputs(f.request, f.gate());
  const actual = JSON.parse(fs.readFileSync(result.profileRef, 'utf8')).provider['openai-b1'].models[f.request.modelID];
  const { knowledge, ...expected } = model;
  assert.deepEqual(actual, expected); result.cleanup();
});

function withheld(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(digest), false);
}

test('missing or old runtime grants refuse before all filesystem access', () => {
  const calls = [];
  const io = new Proxy({}, { get: (_, key) => () => { calls.push(key); throw new Error(secret); } });
  for (const gate of [undefined, {}, { authorized: true }, { authorized: true,
    consent: 'quality-native-canary-v1:fresh-bounded-runtime' }]) {
    assert.throws(() => prepareAuthorizedInputs({}, gate, io), { code: 'credential_materialization_consent_required' });
  }
  assert.deepEqual(calls, []);
});

for (const field of ['sourceConfig', 'inputDirectory', 'canaryRoot', 'providerID', 'modelID', 'sdk', 'baseURL', 'providerDestinations']) {
  test(`gate binds exact ${field} before source access`, (t) => {
    const f = fixture(t); const gate = f.gate(); gate[field] = field === 'providerDestinations' ? [] : 'different';
    const calls = [];
    const io = new Proxy({}, { get: (_, key) => () => { calls.push(key); throw new Error(secret); } });
    assert.throws(() => prepareAuthorizedInputs(f.request, gate, io), { code: 'credential_materialization_scope_mismatch' });
    assert.deepEqual(calls, []);
  });
}

test('inline transfer creates validator-accepted private model-only files without modifying source', (t) => {
  const f = fixture(t); const before = fs.readFileSync(f.request.sourceConfig);
  const result = prepareAuthorizedInputs(f.request, f.gate());
  const profile = JSON.parse(fs.readFileSync(result.profileRef, 'utf8'));
  assert.equal(validateProfile(profile, f.request.providerDestinations), 'openai-b1/gpt-6.1-sol');
  assert.deepEqual(Object.keys(profile).sort(), ['$schema', 'enabled_providers', 'model', 'provider']);
  assert.deepEqual(Object.keys(profile.provider), ['openai-b1']);
  assert.deepEqual(Object.keys(profile.provider['openai-b1'].models), ['gpt-6.1-sol']);
  assert.equal(profile.provider['openai-b1'].options.maxRetries, 0);
  assert.equal(profile.provider['openai-b1'].options.apiKey, `{file:${result.credentialRef}}`);
  assert.equal(fs.readFileSync(result.credentialRef, 'utf8'), secret);
  assert.equal(fs.statSync(f.request.inputDirectory).mode & 0o777, 0o700);
  for (const file of [result.profileRef, result.credentialRef]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(f.request.sourceConfig), before);
  assert.equal(result.profileSha256, createHash('sha256').update(fs.readFileSync(result.profileRef)).digest('hex'));
  withheld(result); withheld(profile);
  result.cleanup();
  assert.equal(fs.existsSync(f.request.inputDirectory), false);
  assert.deepEqual(fs.readFileSync(f.request.sourceConfig), before);
});

for (const segment of ['', './']) test('native reference is preserved without opening or copying its target', (t) => {
  const f = fixture(t); const target = `${f.root}/${segment}external-key`;
  fs.writeFileSync(target, secret, { mode: 0o600 });
  f.source.provider['openai-b1'].options.apiKey = `{file:${target}}`; f.save();
  const reads = []; const opens = [];
  const io = { ...fs, openSync: (file, ...args) => { opens.push(file); return fs.openSync(file, ...args); },
    readFileSync: (file, ...args) => { reads.push(file); return fs.readFileSync(file, ...args); } };
  const result = prepareAuthorizedInputs(f.request, f.gate(), io);
  assert.equal(reads.length, 1);
  assert.deepEqual(opens, [f.request.sourceConfig, result.profileRef]);
  assert.equal(result.credentialRef, target);
  assert.deepEqual(fs.readdirSync(f.request.inputDirectory), ['profile.json']);
  result.cleanup();
  assert.equal(fs.readFileSync(target, 'utf8'), secret);
});

for (const key of [` ${secret}`, `${secret}\n`, '', '{env:NEVER_READ}', '{file:relative}', `${secret}{file:/never}`, '\u0000']) {
  test('unrepresentable credential refuses categorically without owned artifacts', (t) => {
    const f = fixture(t); f.source.provider['openai-b1'].options.apiKey = key; f.save();
    assert.throws(() => prepareAuthorizedInputs(f.request, f.gate()), (error) => {
      withheld(error.stack); return error.code === 'credential_not_losslessly_representable';
    });
    assert.equal(fs.existsSync(f.request.inputDirectory), false);
  });
}

for (const kind of ['existing', 'symlink-directory', 'symlink-source', 'symlink-parent', 'canary-overlap']) {
  test(`refuses ${kind} without reading source or altering existing paths`, (t) => {
    const f = fixture(t); const target = path.join(f.root, 'keep'); fs.mkdirSync(target);
    if (kind === 'existing') fs.mkdirSync(f.request.inputDirectory);
    if (kind === 'symlink-directory') fs.symlinkSync(target, f.request.inputDirectory);
    if (kind === 'symlink-source') { fs.unlinkSync(f.request.sourceConfig); fs.symlinkSync(target, f.request.sourceConfig); }
    if (kind === 'symlink-parent') { fs.symlinkSync(target, path.join(f.root, 'alias')); f.request.inputDirectory = path.join(f.root, 'alias', 'inputs'); }
    if (kind === 'canary-overlap') f.request.inputDirectory = path.join(f.request.canaryRoot, 'inputs');
    let reads = 0;
    assert.throws(() => prepareAuthorizedInputs(f.request, f.gate(), { ...fs, readFileSync() { reads++; throw new Error(secret); } }));
    assert.equal(reads, 0); assert.deepEqual(fs.readdirSync(target), []);
  });
}

test('cleanup leaves canary data, persistent marker and source unchanged', (t) => {
  const f = fixture(t); fs.mkdirSync(f.request.canaryRoot);
  const database = path.join(f.request.canaryRoot, 'database'); const marker = path.join(f.root, 'attempt.json');
  for (const file of [database, marker]) fs.writeFileSync(file, 'keep');
  const result = prepareAuthorizedInputs(f.request, f.gate()); result.cleanup();
  for (const file of [database, marker]) assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  assert.equal(fs.existsSync(f.request.sourceConfig), true);
});

for (const kind of ['extra-file', 'replaced-file', 'symlink-file', 'hardlink-file', 'replaced-directory', 'uid', 'dev']) {
  test(`cleanup refuses unknown ownership ${kind} without deleting files`, (t) => {
    const f = fixture(t); let tamper = false;
    const io = { ...fs, lstatSync(file) { const stat = fs.lstatSync(file);
      if (tamper && file === f.request.inputDirectory && ['uid', 'dev'].includes(kind)) stat[kind]++;
      return stat; } };
    const result = prepareAuthorizedInputs(f.request, f.gate(), io);
    if (kind === 'extra-file') fs.writeFileSync(path.join(f.request.inputDirectory, 'keep'), 'keep');
    if (kind === 'replaced-file') { fs.renameSync(result.profileRef, path.join(f.root, 'saved')); fs.writeFileSync(result.profileRef, 'keep'); }
    if (kind === 'symlink-file') { fs.unlinkSync(result.profileRef); fs.symlinkSync(f.request.sourceConfig, result.profileRef); }
    if (kind === 'hardlink-file') fs.linkSync(result.credentialRef, path.join(f.root, 'linked-key'));
    if (kind === 'replaced-directory') { fs.renameSync(f.request.inputDirectory, path.join(f.root, 'saved')); fs.mkdirSync(f.request.inputDirectory); }
    tamper = true;
    assert.throws(() => result.cleanup(), { code: 'owned_inputs_cleanup_refused' });
    assert.equal(fs.existsSync(f.request.sourceConfig), true);
    assert.equal(fs.existsSync(f.request.inputDirectory), true);
    if (kind !== 'replaced-directory') assert.equal(fs.existsSync(result.credentialRef), true);
  });
}

test('failed profile write cleans only newly owned artifacts and withholds underlying error text', (t) => {
  const f = fixture(t); const before = fs.readFileSync(f.request.sourceConfig);
  const io = { ...fs, openSync(file, ...args) {
    if (file.endsWith('profile.json')) throw new Error(secret);
    return fs.openSync(file, ...args);
  } };
  assert.throws(() => prepareAuthorizedInputs(f.request, f.gate(), io), (error) => {
    withheld(error.stack); return error.code === 'input_preparation_failed';
  });
  assert.equal(fs.existsSync(f.request.inputDirectory), false);
  assert.deepEqual(fs.readFileSync(f.request.sourceConfig), before);
});

test('cleanup failure during preparation remains observable without raw diagnostics', (t) => {
  const f = fixture(t);
  const io = { ...fs, writeFileSync() { throw new Error(secret); }, rmdirSync() { throw new Error(secret); } };
  assert.throws(() => prepareAuthorizedInputs(f.request, f.gate(), io), (error) => {
    withheld(error.stack); return error.code === 'owned_inputs_cleanup_failed';
  });
});

test('same explicit gate object cannot be reused', (t) => {
  const f = fixture(t); const gate = f.gate(); const result = prepareAuthorizedInputs(f.request, gate); result.cleanup();
  assert.throws(() => prepareAuthorizedInputs(f.request, gate), { code: 'credential_materialization_consent_required' });
});

for (const mutate of [
  (f) => { f.source.provider['openai-b1'].npm = '@unreviewed/sdk'; },
  (f) => { f.source.provider['openai-b1'].options.baseURL = 'https://elsewhere.invalid/v1'; },
  (f) => { f.source.provider['openai-b1'].options.headers = { Authorization: secret }; },
  (f) => { delete f.source.provider['openai-b1'].models['gpt-6.1-sol']; },
  (f) => { f.source.provider['openai-b1'].models['gpt-6.1-sol'].options = { apiKey: secret }; },
]) {
  test('unsupported selected provider shape refuses without credential output', (t) => {
    const f = fixture(t); mutate(f); f.save();
    assert.throws(() => prepareAuthorizedInputs(f.request, f.gate()), (error) => { withheld(error.stack); return true; });
    assert.equal(fs.existsSync(f.request.inputDirectory), false);
  });
}

test('invalid JSONC is rejected without echoing parser input', (t) => {
  const f = fixture(t); fs.writeFileSync(f.request.sourceConfig, `{${secret}`);
  assert.throws(() => prepareAuthorizedInputs(f.request, f.gate()), (error) => {
    withheld(error.stack); return error.code === 'source_config_invalid';
  });
});

test('default and help are inert while CLI materialization flags are categorically refused', () => {
  assert.equal(main([]).status, 'not_run');
  assert.equal(main(['--help']).status, 'not_run');
  const result = main([`--materialize=${secret}`]);
  assert.equal(result.status, 'blocked'); withheld(result);
});

for (const destinations of [[], ['https://provider.invalid/v1/*'], ['https://provider.invalid/v1/responses?key=withheld']]) {
  test('imprecise destinations refuse before source read', (t) => {
    const f = fixture(t); f.request.providerDestinations = destinations; let reads = 0;
    assert.throws(() => prepareAuthorizedInputs(f.request, f.gate(), { ...fs, readFileSync() { reads++; } }),
      { code: 'reviewed_destinations_required' });
    assert.equal(reads, 0); assert.equal(fs.existsSync(f.request.inputDirectory), false);
  });
}

test('partial credential write failure removes only recorded owned files', (t) => {
  const f = fixture(t);
  const io = { ...fs, writeFileSync(fd) { fs.writeFileSync(fd, secret.slice(0, 9)); throw new Error(secret); } };
  assert.throws(() => prepareAuthorizedInputs(f.request, f.gate(), io), (error) => {
    withheld(error.stack); return error.code === 'input_preparation_failed';
  });
  assert.equal(fs.existsSync(f.request.inputDirectory), false);
});

test('unknown identity immediately after mkdir is reported without guessing ownership', (t) => {
  const f = fixture(t);
  const io = { ...fs, lstatSync(file) {
    if (file === f.request.inputDirectory && fs.existsSync(file)) throw new Error(secret);
    return fs.lstatSync(file);
  } };
  assert.throws(() => prepareAuthorizedInputs(f.request, f.gate(), io), (error) => {
    withheld(error.stack); return error.code === 'owned_inputs_cleanup_refused';
  });
  assert.deepEqual(fs.readdirSync(f.request.inputDirectory), []);
});

test('private mode mismatch fails before writing and cleans newly owned artifacts', (t) => {
  const f = fixture(t);
  const io = { ...fs, openSync(file, flags, mode) { return fs.openSync(file, flags, mode === 0o600 ? 0o400 : mode); } };
  assert.throws(() => prepareAuthorizedInputs(f.request, f.gate(), io), { code: 'owned_input_permissions_required' });
  assert.equal(fs.existsSync(f.request.inputDirectory), false);
});

test('public Node CLI emits categorical JSON without inherited grants enabling preparation', () => {
  const { spawnSync } = require('node:child_process');
  for (const args of [[], ['--help'], [`--materialize=${secret}`]]) {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'authorized-inputs.cjs'), ...args],
      { encoding: 'utf8', env: { MEMOCAP_NATIVE_ENABLE: '1', OPENCODE_CONFIG: secret } });
    assert.equal(child.status, 0); assert.equal(child.stderr, ''); withheld(child.stdout);
    assert.equal(JSON.parse(child.stdout).status, args[0]?.startsWith('--materialize=') ? 'blocked' : 'not_run');
  }
});
