const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { digest, write } = require('../setup-package-lifecycle-fixture.cjs');

function prototype(root) {
  const deltas = [];
  function edit(relative, before, after) {
    const filename = path.join(root, relative);
    const source = fs.readFileSync(filename, 'utf8');
    assert.equal(source.split(before).length, 2, `scratch patch unique: ${relative}`);
    const changed = source.replace(before, after);
    write(filename, changed);
    deltas.push({ path: relative, before_sha256: digest(source), after_sha256: digest(changed), before, after });
  }
  const observed = fs.readFileSync(path.join(__dirname, 'observed.mjs'), 'utf8');
  write(path.join(root, 'plugin/capture/spike-observed.js'), observed);
  deltas.push({ path: 'plugin/capture/spike-observed.js', before_sha256: null, after_sha256: digest(observed), source: observed });
  edit('plugin/capture/index.js', '  const binding = createBinding({ client: input.client, runtime, operations, lifecycle });',
    '  const observed = input.spikeObserved;\n  const binding = createBinding({ client: input.client, runtime, operations, lifecycle, observed });');
  edit('plugin/capture/index.js', '  const run = createWorker({ client: input.client, runtime, lifecycle });',
    '  const run = createWorker({ client: input.client, runtime, lifecycle, observed });');
  edit('plugin/capture/index.js', 'return { ...binding, observe: lifecycle.observe,',
    'return { ...binding, observe(input, output) { if (!lifecycle.workers.has(input.sessionID)) observed.observe(input, output); lifecycle.observe(input, output); },');
  edit('plugin/capture/index.js', '    event({ event }) {\n      const turn', '    event({ event }) {\n      observed.event(event);\n      const turn');
  edit('plugin/capture/worker.js', 'createWorker({ client, runtime, lifecycle })', 'createWorker({ client, runtime, lifecycle, observed })');
  edit('plugin/capture/worker.js', 'client.session.messages({ path: { id: turn.parentID }, signal: turn.controller.signal })',
    'Promise.resolve({ data: observed.snapshot(turn.parentID, turn.userID) })');
  edit('plugin/capture/worker.js', 'const evidence = evidenceFor(messages, turn.userID);',
    'const evidence = evidenceFor(messages.map((message) => ({ ...message, parts: message.parts.filter((part) => part.type !== "tool" || typeof part.state.output === "string") })), turn.userID);');
  edit('plugin/capture/worker.js', '    const identity = identify(', `    const support = data(await client.session.prompt({ path: { id: extractID }, signal: turn.controller.signal, body: {
      model: turn.model, agent: turn.agent, tools: Object.fromEntries(tools.map((id) => [id, false])),
      system: 'Check support of the proposed evidence. Return JSON with supported boolean. No tools.',
      parts: [{ type: 'text', text: JSON.stringify({ proposal, evidence: units }) }],
    } }));
    lifecycle.check(turn);
    const verdict = JSON.parse(support.parts.filter((part) => part.type === 'text').map((part) => part.text).join(''));
    if (verdict.supported !== true) throw new CaptureStop('unsupported');
    const identity = identify(`);
  edit('plugin/capture/binding.js', 'createBinding({ client, runtime, operations, lifecycle })',
    'createBinding({ client, runtime, operations, lifecycle, observed })');
  edit('plugin/capture/binding.js', 'data(await client.session.messages({ path: { id: turn.parentID }, signal: turn.controller.signal }))',
    'observed.snapshot(turn.parentID, turn.userID)');
  return deltas;
}
module.exports = { prototype };
