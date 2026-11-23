const assert = require('node:assert/strict');

async function drive(evidence) {
  const api = await import('../../plugin/capture/sources.js');
  const results = new Map();
  const pairs = [];
  for (const observation of evidence.observations) {
    for (const message of observation.messages) {
      for (const part of message.parts) {
        if (part.type !== 'tool') continue;
        const result = api.adaptSource({ host_version: evidence.host.version, user_id: observation.user_id,
          observed_at: observation.observed_at, message: message.info, part });
        results.set(observation.name, result);
        pairs.push([observation, result]);
      }
    }
  }
  for (const name of ['code.js', 'config.json', 'script.sh', 'runbook.md']) {
    assert.equal(results.get(name).source.kind, 'file_content');
    assert.equal(results.get(name).source.completeness, 'full');
  }
  for (const name of ['long.txt', 'wide.txt', 'offset', 'large-output']) assert.equal(results.get(name).status, 'skip');
  assert.deepEqual(results.get('failed').source.outcome, { type: 'process_exit', exit_code: 7 });
  assert.deepEqual(results.get('missing').source.outcome, { type: 'reported_failure' });
  for (const name of ['queued', 'repair', 'verify', 'mock-accepted', 'mock-verified']) {
    assert.deepEqual(results.get(name).source.outcome, { type: 'process_exit', exit_code: 0 });
  }
  const body = (name) => JSON.parse(results.get(name).source.text.split('\n\n')[1]);
  assert.equal(body('mock-accepted').state, 'queued');
  assert.equal(body('mock-verified').state, 'completed');
  const runbook = results.get('runbook.md').source;
  const sequence = pairs.filter(([observation]) => observation.name === 'failure-repair-verify').map(([, result]) => result.source);
  assert.deepEqual(sequence.map((source) => source.outcome.exit_code), [7, 0, 0]);
  assert.equal(new Set(sequence.map((source) => source.user_id)).size, 1);
  assert.equal(new Set(sequence.map((source) => source.call_id)).size, 3);
  const pool = api.sourceBundles([runbook]);
  const selected = api.selectBundles(pool.bundles, { user_id: runbook.user_id, text: 'docs/alpha.md verify' });
  assert.equal(selected.units, 2);
  assert.ok(selected.bundles[0].units.some((unit) => unit.text.includes('Never use for beta.')));
  const code = results.get('code.js').source;
  const index = [...code.text].indexOf('😀');
  assert.equal(api.resolveQuote(code, { source_id: code.source_id, content_hash: code.content_hash,
    span: { start: index, end: index + 1 }, quote: '😀' }), '😀');
  return {
    results: Object.fromEntries(pairs.map(([observation, result]) => [observation.name,
      result.status === 'source' ? { status: result.status, source: result.source } : result])),
    profile_candidate: api.sourceProfile, selected_units: selected.units, selected_bytes: selected.bytes,
    adapter_io: 0, provider_requests_by_adapter: 0, business_success_inferred: false,
    original_deleted_file_still_historical: code.pointer.hash_scope === 'observed_text',
    same_request_failure_repair_verification: sequence.map((source) => ({ source_id: source.source_id,
      user_id: source.user_id, tool_status: source.tool_status, outcome: source.outcome })),
  };
}
module.exports = { drive };

if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const root = path.resolve(__dirname, '../..');
  const directory = path.join(root, '.omo/evidence/capture-expansion');
  (async () => {
    const replays = [];
    for (const version of ['1.19.3', '1.19.5']) {
      const evidence = JSON.parse(fs.readFileSync(path.join(directory, `source-adapters-host-${version}.json`), 'utf8'));
      const result = await drive(evidence);
      replays.push({ version, selected_units: result.selected_units, selected_bytes: result.selected_bytes,
        same_request_sequence: result.same_request_failure_repair_verification.length, status: 'passed' });
    }
    const modules = ['sources.js', ...['profile', 'read', 'sections', 'selection', 'value'].map((name) => `sources/${name}.js`)];
    const source_hashes = Object.fromEntries(modules.map((file) => [file,
      createHash('sha256').update(fs.readFileSync(path.join(root, 'plugin/capture', file))).digest('hex')]));
    fs.writeFileSync(path.join(directory, 'source-adapters-replay.json'), `${JSON.stringify({ replays, source_hashes }, null, 2)}\n`);
    console.log(JSON.stringify(replays));
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
