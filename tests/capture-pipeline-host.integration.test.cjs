const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { harness } = require('./capture-pipeline-host/harness.cjs');
const { pipeline, generation } = require('./capture-pipeline-host/helpers.cjs');
const { probes, identity } = require('./capture-pipeline-host/probes.cjs');
const { continuity } = require('./capture-pipeline-host/continuity.cjs');
const { acquisition } = require('./capture-pipeline-host/acquisition.cjs');
const { write } = require('./setup-package-lifecycle-fixture.cjs');

test('production capture pipeline through official OpenCode wire provider and native dispatcher',
  { skip: process.env.MEMOCAP_CAPTURE_E2E !== '1', timeout: 600000 }, async (t) => {
  assert.ok(['0', '1'].includes(process.env.MEMOCAP_CAPTURE_PACKAGED_HOST), 'explicit isolated host required');
  const version = process.env.MEMOCAP_CAPTURE_PACKAGED_HOST === '1' ? '1193' : '1195';
  const destination = path.resolve(__dirname, '../.omo/evidence/capture-expansion');
  const scratch = path.join(destination, `pipeline-${version}-${Date.now()}`);
  const evidence = { mode: 'production', status: 'WORKING', cleanup: {}, cases: [], commands: [] };
  process.stderr.write(`WORKING pipeline ${version}: isolated package and official host preparation\n`);
  const current = pipeline(await harness(evidence, scratch));
  try {
    await generation(current, evidence);
    await identity(current, evidence);
    await continuity(current, evidence);
    await probes(current, evidence);
    const sdk = current.control.events.filter((event) => event.phase === 'capture.sdk');
    const children = new Set(sdk.filter((event) => event.method === 'session.create').map((event) => event.response.data.id));
    assert.ok(sdk.some((event) => event.method === 'session.messages'));
    assert.ok(sdk.filter((event) => event.method === 'session.messages').every((event) => children.has(event.request.path.id)));
    assert.deepEqual(current.provider.errors, []);
    evidence.parent_history_reads = 0;
    evidence.status = 'passed_pipeline_host';
  } catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
  finally {
    await current.close();
    write(path.join(destination, `capture-pipeline-host-${version}.json`), JSON.stringify(evidence, null, 2));
    t.diagnostic(JSON.stringify({ status: evidence.status, cases: evidence.cases.length, cleanup: evidence.cleanup }));
  }
});

test('bounded capture-only official host acquisition for 32 and 128 completed turns',
  { skip: process.env.MEMOCAP_CAPTURE_E2E !== '1', timeout: 600000 }, async (t) => {
  assert.ok(['0', '1'].includes(process.env.MEMOCAP_CAPTURE_PACKAGED_HOST), 'explicit isolated host required');
  const version = process.env.MEMOCAP_CAPTURE_PACKAGED_HOST === '1' ? '1193' : '1195';
  const destination = path.resolve(__dirname, '../.omo/evidence/capture-expansion');
  const evidence = { mode: 'production', entry: 'capture_only', status: 'WORKING', cleanup: {}, cases: [], commands: [] };
  process.stderr.write(`WORKING bounded pipeline ${version}: isolated production capture entry without maintenance\n`);
  const current = pipeline(await harness(evidence, path.join(destination, `pipeline-bounded-${version}-${Date.now()}`)));
  try { await acquisition(current, evidence); evidence.status = 'passed_bounded_capture_host'; }
  catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
  finally {
    await current.close();
    write(path.join(destination, `capture-pipeline-acquisition-${version}.json`), JSON.stringify(evidence, null, 2));
    t.diagnostic(JSON.stringify({ status: evidence.status, cases: evidence.cases.length, cleanup: evidence.cleanup }));
  }
});
