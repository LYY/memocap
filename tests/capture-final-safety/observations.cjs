const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { digest } = require('../packaged-runtime.cjs');
const repo = path.resolve(__dirname, '../..');
const destination = path.join(repo, '.omo/evidence/capture-expansion');
const raw = 'FINAL_RAW_SOURCE_82bfe5 local synthetic command result: route=fixture; code=17.';
const secret = 'FINAL_MARKED_SECRET_43fbd9';
const markers = [raw, secret, 'fixture-native-only', 'fixture-only'];
function source() {
  const canonical = require('../capture-quality-population-native/authorization.cjs').sources();
  return { manifest: Object.fromEntries(canonical.entries), sha256: canonical.digest };
}
function rows(database) {
  const result = childProcess.spawnSync('/usr/bin/sqlite3', ['-readonly', '-json', database,
    'SELECT * FROM activity_events ORDER BY sequence;'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout || '[]');
}
function absence(values, sentinels = markers) {
  const hits = values.flatMap((value, index) => sentinels.filter((marker) => JSON.stringify(value).includes(marker))
    .map((marker) => ({ index, marker_sha256: digest(marker) })));
  assert.deepEqual(hits, [], 'persisted or worker sentinel exposure');
  return { rows: values.length, distinct_markers: new Set(sentinels).size, comparisons: values.length * new Set(sentinels).size, violations: hits.length };
}
async function descendants(current, parentID) {
  const found = [];
  const visit = async (id) => {
    const children = current.unwrap(await current.client.session.children({ path: { id } }));
    for (const child of children) { found.push(child); await visit(child.id); }
  };
  await visit(parentID);
  const active = current.unwrap(await current.client.session.status());
  return found.map(({ id, parentID, title }) => ({ id, parentID, title, status: active[id]?.type ?? 'idle' }));
}
function record(evidence, clause, details) {
  const selector = `${evidence.selector_file}::${details.case_id}`;
  evidence.safety_observations.push({ clause, lane: evidence.lane, selector,
    source_sha256: evidence.source.sha256, selector_sha256: digest(fs.readFileSync(path.join(repo, evidence.selector_file))),
    host_version: evidence.host?.version ?? process.versions.node,
    host_sha256: evidence.host?.sha256 ?? digest(fs.readFileSync(process.execPath)),
    native_sha256: evidence.native?.sha256 ?? digest(fs.readFileSync(path.join(repo, 'target/debug/memocap'))),
    denominator: details.denominator, violations: details.violations, result: details.violations === 0 ? 'satisfied' : 'violated' });
}
function persist(directory, evidence) {
  fs.writeFileSync(path.join(directory, 'observations.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
}
module.exports = { repo, destination, raw, secret, markers, source, rows, absence, descendants, record, persist };
