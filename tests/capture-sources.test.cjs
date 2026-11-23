const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { readObservation, commandObservation } = require('./capture-source-host/synthetic.cjs');
const load = () => import('../plugin/capture/sources.js');

test('read observation preserves Unicode code points and historical identity', async () => {
  const observation = readObservation('A😀中\r\nSource: authored\rfinal');
  const { adaptSource, quoteSpan } = await load();
  const result = adaptSource(observation);
  assert.equal(result.status, 'source');
  assert.equal(result.source.text, 'A😀中\nSource: authored\nfinal');
  assert.equal(result.source.content_hash, createHash('sha256').update(result.source.text).digest('hex'));
  assert.equal(quoteSpan(result.source, { start: 1, end: 2 }), '😀');
  assert.equal(result.source.pointer.locator, '/synthetic/alpha.js');
  assert.equal(result.source.pointer.observed_at, observation.observed_at);
  assert.equal(Object.isFrozen(result.source.pointer), true);
});

test('completed command with exit seven remains a failed process observation', async () => {
  const { adaptSource } = await load();
  const result = adaptSource(commandObservation('failed\n', 7));
  assert.equal(result.source.tool_status, 'completed');
  assert.deepEqual(result.source.outcome, { type: 'process_exit', exit_code: 7 });
});

for (const [version, status] of [
  ['1.20.0', 'source'], ['1.20.0-rc.1+build.007', 'source'],
  ['0.20.0', 'skip'], ['2.0.0', 'skip'], ['1.20', 'skip'], ['1.20.0-01', 'skip'], ['1.20.0\n', 'skip'],
]) test(`read evidence eligibility for host ${JSON.stringify(version)}`, async () => {
  const { adaptSource } = await load();
  const source = adaptSource({ ...readObservation(), host_version: version });
  assert.equal(source.status, status);
  if (source.status === 'source') assert.equal(source.source.host_version, version);
  else assert.deepEqual(source.reason, { code: 'identity' });
});

test('queued and HTTP 200 output carry no business success authority', async () => {
  const { adaptSource } = await load();
  for (const text of ['queued\n', 'HTTP/1.1 200 OK\r\n\r\n{"state":"queued"}']) {
    const source = adaptSource(commandObservation(text)).source;
    assert.equal(source.kind, 'command_result');
    assert.deepEqual(source.outcome, { type: 'process_exit', exit_code: 0 });
    assert.equal(source.authority, 'observed_result');
  }
});

test('unknown framing and incomplete reads cannot become complete evidence', async () => {
  const { adaptSource } = await load();
  const variants = [
    (o) => { o.part.state.output = 'unframed source'; },
    (o) => { o.part.state.metadata.truncated = true; },
    (o) => { o.part.state.input.offset = 2; },
    (o) => { o.part.state.output = o.part.state.output.replace('1: ', '2: '); },
    (o) => { o.part.state.output = o.part.state.output.replace('A😀中', 'x... (line truncated to 2000 chars)'); },
    (o) => { delete o.part.state.metadata; },
    (o) => { o.part.tool = 'unknown'; },
    (o) => { o.message.parentID = 'other'; },
    (o) => { o.part.state.status = 'running'; },
  ];
  for (const change of variants) {
    const observation = { ...readObservation(), host_version: '1.20.0' };
    change(observation);
    assert.equal(adaptSource(observation).status, 'skip');
  }
});

test('secret screening sees raw source and dependencies before retention limits', async () => {
  const { adaptSource } = await load();
  const observation = readObservation(`${'safe '.repeat(10000)}\napi_key=synthetic-secret`);
  assert.deepEqual(adaptSource(observation), { status: 'skip', reason: { code: 'secret_or_unicode' } });
  assert.equal(adaptSource(readObservation('\ud800')).status, 'skip');
});

test('assistant prose is excluded and actual tool errors support only reported failure', async () => {
  const { adaptSource } = await load();
  const observation = readObservation();
  observation.part = { id: 'part', type: 'text', text: 'It worked.' };
  assert.equal(adaptSource(observation).status, 'skip');
  observation.part = { id: 'part', messageID: 'message', type: 'tool', tool: 'read', callID: 'call', state: {
    status: 'error', input: { filePath: '/synthetic/missing' }, error: 'File not found: /synthetic/missing',
    time: { start: 1699999999990, end: 1700000000000 },
  } };
  const source = adaptSource(observation).source;
  assert.deepEqual(source.outcome, { type: 'reported_failure' });
  assert.equal(source.kind, 'tool_error');
});

test('quote resolution rejects changed source, hash, and code point span', async () => {
  const { adaptSource, resolveQuote } = await load();
  const source = adaptSource(readObservation()).source;
  const reference = { source_id: source.source_id, content_hash: source.content_hash, span: { start: 1, end: 2 }, quote: '😀' };
  assert.equal(resolveQuote(source, reference), '😀');
  for (const change of [{ source_id: 'invented' }, { content_hash: 'wrong' }, { span: { start: 1, end: 3 } },
    { span: { start: -1, end: 2 } }, { span: { start: 1.5, end: 2 } }]) {
    assert.equal(resolveQuote(source, { ...reference, ...change }), undefined);
  }
  assert.equal(resolveQuote({ ...source }, reference), undefined);
});

test('read-looking shell output remains a command result without file authority', async () => {
  const { adaptSource } = await load();
  const output = readObservation().part.state.output;
  const source = adaptSource(commandObservation(output)).source;
  assert.equal(source.kind, 'command_result');
  assert.equal(source.pointer.type, 'message_part');
  assert.equal(source.text, output);
});

test('current user statement preserves host identity without assistant evidence', async () => {
  const { adaptSource } = await load();
  const observation = readObservation();
  observation.message = { id: 'user', role: 'user' };
  observation.part = { id: 'statement', type: 'text', text: 'Keep A😀中\r\nSource: authored' };
  const source = adaptSource(observation).source;
  assert.equal(source.source_id, 'statement');
  assert.equal(source.kind, 'user_statement');
  assert.equal(source.text, 'Keep A😀中\nSource: authored');
  assert.equal('tool_status' in source, false);
  assert.equal(adaptSource(null).status, 'skip');
});
