const assert = require('node:assert/strict');
const test = require('node:test');
const load = import('../plugin/capture/evidence.js');
const read = (text) => [{ info: { id: 'a', parentID: 'u' }, parts: [{ id: 'read', type: 'tool', tool: 'read', callID: 'call',
  state: { status: 'completed', input: { filePath: '/project/docs/navigation.md' }, output: text } }] }];

test('keeps an ordinary preference in a later paragraph without a future prefix', async () => {
  const text = 'The report is ready.\n\nI prefer Chinese responses. Keep code identifiers in English.';
  const evidence = (await load).evidenceFor([{ info: { id: 'u', role: 'user' }, parts: [{ id: 'p', type: 'text', text }] }], 'u');
  assert.equal(evidence.get('p').eligibility, 'durable');
  assert.equal(evidence.get('p').text, text);
});

test('extracts a complete short route from a long Markdown document with an unrelated code block', async () => {
  const section = '# Project\n\n## Alpha environment\n\nFor alpha, start at docs/alpha.md. Approval required.\n\nNever use this entry for beta.';
  const document = `${section}\n\n## Development\n\n\`\`\`sh\n${'build project\n'.repeat(120)}\`\`\``;
  const units = (await load).extractionUnits((await load).evidenceFor(read(document), 'u'));
  assert.ok(units.some((unit) => unit.text === section));
  assert.equal(units.some((unit) => unit.text.includes('build project')), false);
});

test('does not offer a prefix from a long section whose prohibition is at its tail', async () => {
  const document = `# Alpha\n\nStart at docs/alpha.md.\n\n${'Condition applies. '.repeat(80)}\n\nNever use this entry for beta.`;
  const units = (await load).extractionUnits((await load).evidenceFor(read(document), 'u'));
  assert.deepEqual(units, []);
});

test('keeps ancestor environment and conditions with a leaf section', async () => {
  const context = '# Alpha only\n\nApproval required. Never use for beta.';
  const route = '## Entry\n\nStart at docs/alpha.md.';
  const units = (await load).extractionUnits((await load).evidenceFor(read(`${context}\n\n${route}\n\n## Other\n\n${'unrelated '.repeat(150)}`), 'u'));
  assert.equal(units[0].text, `${context}\n\n${route}`);
});

test('complete numbered runbooks remain rejected per candidate unit', async () => {
  const evidence = (await load).evidenceFor(read('# Release\n\nStart at docs/release.md.\n1. Run one.\n2. Run two.'), 'u');
  assert.equal([...evidence.values()][0].eligibility, 'runbook');
});

test('actual host numbered read output retains full section context and ignores only host framing', async () => {
  const section = '# Project\n\n## Alpha\n\nStart at docs/alpha.md.\nSource: user-authored line\nNever use for beta.';
  const document = `${section}\n\n## Build\n\n\`\`\`sh\nbuild\n\`\`\``;
  const lines = document.split('\n');
  const output = `<path>/project/docs/navigation.md</path>\n<type>file</type>\n<content>\n${lines.map((line, index) => `${index + 1}: ${line}`).join('\n')}\n\n(End of file - total ${lines.length} lines)\n</content>`;
  const units = (await load).extractionUnits((await load).evidenceFor(read(output), 'u'));
  assert.equal(units.find((unit) => unit.text.includes('docs/alpha.md')).text, section);
});

test('rejects truncated or offset read output instead of treating its prefix as a whole source', async () => {
  const output = '<path>/project/docs/navigation.md</path>\n<type>file</type>\n<content>\n10: Start at docs/alpha.md.\n\n(End of file - total 10 lines)\n</content>';
  const units = (await load).extractionUnits((await load).evidenceFor(read(output), 'u'));
  assert.deepEqual(units, []);
});
