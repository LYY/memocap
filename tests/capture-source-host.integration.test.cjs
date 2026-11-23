const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { harness } = require('./capture-source-host/harness.cjs');
const { drive } = require('./capture-source-host/driver.cjs');
const { write } = require('./packaged-runtime.cjs');
const destination = path.resolve(__dirname, '../.omo/evidence/capture-expansion');

test('actual supported hosts expose synthetic source framing', {
  skip: process.env.MEMOCAP_CAPTURE_SOURCE_HOST !== '1', timeout: 600000,
}, async () => {
  for (const version of ['1.19.3', '1.19.5']) {
    const evidence = { commands: [], cleanup: {}, observations: [], business_requests: 0,
      capture_parent_history_requests: 0, qa_history_inspection: 'external SDK session.messages, synthetic sessions only' };
    process.stderr.write(`WORKING source framing host=${version}\n`);
    const current = await harness(evidence, version);
    try {
      const files = {
        'code.js': 'export const alpha = "A😀中";\n',
        'config.json': '{"environment":"alpha","approval":true}\n',
        'script.sh': '#!/bin/sh\nprintf "queued\\n"\n',
        'runbook.md': '# Alpha only\n\nApproval required. Never use for beta.\n\n## Verify\n\n1. Start at docs/alpha.md.\n2. Verify the result.\n\n```sh\nprintf completed\n```\n',
        'long.txt': 'bounded line\n'.repeat(2100),
        'wide.txt': `${'x'.repeat(3000)}\n`,
      };
      for (const [name, text] of Object.entries(files)) {
        const filePath = path.join(current.fixture.project, name);
        write(filePath, text);
        const part = await current.observe(name, { tool: 'read', args: { filePath } });
        assert.equal(part.state.status, 'completed');
      }
      await current.observe('offset', { tool: 'read', args: { filePath: path.join(current.fixture.project, 'long.txt'), offset: 2099 } });
      await current.observe('missing', { tool: 'read', args: { filePath: path.join(current.fixture.project, 'absent.js') } });
      const shell = (command) => ({ tool: 'bash', args: { command, description: 'Synthetic source fixture' } });
      for (const [name, command] of [
        ['queued', 'printf "queued\\n"'], ['failed', 'printf "failed\\n"; exit 7'],
        ['repair', 'printf "fixed\\n" > repaired.txt'], ['verify', 'test "$(cat repaired.txt)" = fixed && printf "verified\\n"'],
        ['mock-accepted', `curl -sS -i -X POST ${current.mockURL}/jobs`],
        ['mock-verified', `curl -sS -i ${current.mockURL}/jobs/synthetic-job`],
        ['large-output', 'i=0; while [ "$i" -lt 2100 ]; do printf "line\\n"; i=$((i+1)); done'],
      ]) await current.observe(name, shell(command));
      await current.observe('failure-repair-verify', [
        shell('printf "failed\\n"; exit 7'),
        shell('printf "fixed\\n" > sequence-repaired.txt'),
        shell('test "$(cat sequence-repaired.txt)" = fixed && printf "independently verified\\n"'),
      ]);
      assert.deepEqual(evidence.mock_requests, [{ method: 'POST', path: '/jobs' }, { method: 'GET', path: '/jobs/synthetic-job' }]);
      assert.deepEqual(current.provider.errors, []);
      fs.unlinkSync(path.join(current.fixture.project, 'code.js'));
      evidence.adapters = await drive(evidence);
      evidence.status = 'observed';
    } catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
    finally {
      await current.close();
      write(path.join(destination, `source-adapters-host-${version}.json`), JSON.stringify(evidence, null, 2));
    }
  }
});
