const assert = require('node:assert/strict');
const test = require('node:test');
const { createCarrier } = require('./carrier.cjs');
const { createCustody } = require('./custody.cjs');
const { createEvaluation } = require('./evaluation.cjs');
const { toy, digest } = require('./evaluation-fixture.cjs');

function evaluation(body) {
  const input = toy(); const data = JSON.parse(input.input_utf8);
  data.capture[0].turns[0].tools[0].output = body;
  input.input_utf8 = JSON.stringify(data); input.input_sha256 = digest(input.input_utf8);
  input.mapping.tuning_sha256 = input.input_sha256; input.mapping_sha256 = digest(JSON.stringify(input.mapping));
  return createEvaluation(input);
}

async function prepared(body, observed) {
  const carrier = createCarrier('toy-read', { root: '/synthetic/private', node: '/synthetic/node' }, evaluation(body));
  const step = carrier.prepare(carrier.operations(0)[0].token);
  const custody = await createCustody({ sessionID: 'root', version: '1.19.5' }, carrier);
  custody.user({ message: { id: 'user', role: 'user', sessionID: 'root' }, parts: [{ id: 'user-part',
    messageID: 'user', sessionID: 'root', type: 'text', text: 'Synthetic request.' }] }, { user: 'Synthetic request.', turn: 0 });
  const lines = observed.split('\n'); const file = step.input.filePath;
  const value = { userID: 'user', message: { id: 'assistant', parentID: 'user', sessionID: 'root', role: 'assistant' },
    part: { id: 'part', messageID: 'assistant', sessionID: 'root', callID: 'call', type: 'tool', tool: 'read', state: {
      status: 'completed', input: step.input, time: { start: 1, end: 2 },
      output: `<path>${file}</path>\n<type>file</type>\n<content>\n${lines.map((line, index) => `${index + 1}: ${line}`).join('\n')}\n\n(End of file - total ${lines.length} lines)\n</content>`,
      metadata: { truncated: false, display: { type: 'file', path: file, text: observed,
        lineStart: 1, lineEnd: lines.length, totalLines: lines.length, truncated: false } },
    } } };
  return { carrier, custody, step, value };
}

for (const [name, body, observed] of [
  ['terminal LF', 'ALPHA\nBRAVO😀中\n', 'ALPHA\nBRAVO😀中'],
  ['retained blank line', 'ALPHA\n\nBRAVO\n\n', 'ALPHA\n\nBRAVO\n'],
  ['CRLF', 'ALPHA\r\nBRAVO\r\n', 'ALPHA\nBRAVO'],
  ['unterminated line', 'ALPHA\nBRAVO', 'ALPHA\nBRAVO'],
  ['significant spaces', ' ALPHA \nBRAVO \n', ' ALPHA \nBRAVO '],
]) test(`custody accepts pinned native read projection with ${name} while preserving raw bytes`, async () => {
  const current = await prepared(body, observed);
  current.custody.tool(current.value);
  const row = current.custody.rows().at(-1);
  assert.equal(row.source_hash, digest(observed));
  assert.equal(row.raw_source_hash, digest(body));
  assert.equal(row.original_output_hash, digest(body));
  assert.equal(current.step.files[0].bytes, body);
});

for (const [name, mutate] of [
  ['tampered content', (value) => { value.part.state.output = value.part.state.output.replace('BRAVO', 'OTHER'); }],
  ['consistent foreign content', (value) => { value.part.state.output = value.part.state.output.replace('BRAVO', 'OTHER'); value.part.state.metadata.display.text = 'ALPHA\nOTHER'; }],
  ['partial', (value) => { value.part.state.metadata.display.truncated = true; }],
  ['missing metadata', (value) => { delete value.part.state.metadata; }],
  ['line count', (value) => { value.part.state.metadata.display.totalLines++; }],
  ['path', (value) => { value.part.state.metadata.display.path = '/foreign'; }],
  ['foreign parent', (value) => { value.message.parentID = 'foreign'; }],
  ['extra terminal blank line', (value) => { value.part.state.metadata.display.text += '\n'; }],
]) test(`projected native read still rejects ${name}`, async () => {
  const current = await prepared('ALPHA\nBRAVO\n', 'ALPHA\nBRAVO');
  mutate(current.value);
  assert.throws(() => current.custody.tool(current.value), /native_source_bytes_or_framing|native_source_identity/);
  assert.equal(current.carrier.audit().observed, 0);
});
