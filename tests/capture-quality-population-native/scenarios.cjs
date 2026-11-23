const assert = require('node:assert/strict');
const { runCase } = require('./adapter.cjs');
const { fakeHost } = require('./fake-host.cjs');
const { createLedger } = require('./ledger.cjs');
const { createMeter } = require('./inventory.cjs');
const { hash } = require('./value.cjs');
const offline = { mode: 'offline', approved: false };

const sourceMutations = [
  ['forged-user', (value) => { value.userID = 'foreign-user'; }],
  ['forged-parent', (value) => { value.message.parentID = 'foreign-user'; }],
  ['forged-message', (value) => { value.part.messageID = 'foreign-message'; }],
  ['forged-session', (value) => { value.part.sessionID = 'foreign-session'; }],
  ['forged-call', (value) => { value.part.callID = ''; }],
  ['forged-tool', (value) => { value.part.tool = 'custom_mock'; }],
  ['forged-path', (value) => { value.part.state.input.filePath = '/another-file'; }],
  ['truncated', (value) => { value.part.state.metadata.truncated = true; }],
  ['forged-display', (value) => { value.part.state.metadata.display.text = 'invented'; }],
  ['incomplete', (value) => { value.part.state.status = 'running'; }],
  ['synthetic', (value) => { value.part.synthetic = true; }],
];

function savedScenario(context, changes = {}) {
  const { boundary, session: root, user } = context;
  const record = { id: 301, placement: 'repository:synthetic-native', content: 'Unexpected qualified output.',
    content_hash: hash('Unexpected qualified output.'), tags_hash: hash('tag'), completeness: 'full' };
  const binding = { root, user, session: 'commit-child', message: 'commit-message', tool: 'memocap_remember' };
  const attempt = `attempt-${user}`;
  boundary.record({ ...binding, kind: 'permission', outcome: changes.denied ? 'denied' : 'resolved' });
  boundary.record({ ...binding, workflow: changes.workflow ?? 'capture', kind: 'native.dispatch', attempt, permission: 'resolved' });
  if (changes.unknown) return { status: 'unknown' };
  const commit = { status: 'inserted', operation: 'remember', operation_id: 'write-op', records: [record], returned_ids: [301] };
  boundary.record({ ...binding, kind: 'native.commit', attempt, receipt: commit });
  const read = { status: 'ok', operation: 'read', operation_id: changes.sameOperation ? 'write-op' : 'read-op',
    records: [{ ...record, ...(changes.wrongID ? { id: 999 } : {}) }], returned_ids: [301], truncated: false, error_code: null, error_present: false };
  boundary.record({ ...binding, kind: 'native.readback', attempt, receipt: read });
  return { status: 'saved' };
}

async function adversaries() {
  const results = [];
  for (const [name, mutateSource] of sourceMutations) {
    const result = await runCase('read-route', { host: fakeHost({ mutateSource }), budget: offline });
    assert.equal(result.status, 'blocked', name); assert.equal(result.cleanup.children, 0);
    results.push({ name, status: 'refused', reason: result.reason });
  }
  for (const [name, id, options, expected] of [
    ['forged-user-part', 'read-route', { mutateUser(value) { value.parts[0].messageID = 'foreign-user'; } }, 'blocked'],
    ['partial-promoted', 'partial-read', { mutateSource(value) { value.part.state.input.offset = 1; } }, 'blocked'],
    ['missing-completion', 'read-route', { omitCompletion: true }, 'blocked'],
    ['foreign-completion', 'read-route', { mutateCompletion(info) { info.parentID = 'foreign'; } }, 'blocked'],
    ['missing-adoption', 'verified-condition-update', { omitUse: true }, 'blocked'],
    ['cold-cleanup', 'read-route', { cleanup: { exited: false, children: 1, removed: false } }, 'blocked'],
    ['denied-write', 'read-route', { settle: (context) => savedScenario(context, { denied: true }) }, 'blocked'],
    ['wrong-readback', 'read-route', { settle: (context) => savedScenario(context, { wrongID: true }) }, 'blocked'],
    ['same-operation-readback', 'read-route', { settle: (context) => savedScenario(context, { sameOperation: true }) }, 'blocked'],
    ['unknown-retained', 'read-route', { settle: (context) => savedScenario(context, { unknown: true }) }, 'wired'],
    ['unexpected-negative-save', 'dropped-condition', { settle: (context) => savedScenario(context) }, 'wired'],
  ]) {
    const result = await runCase(id, { host: fakeHost(options), budget: offline });
    assert.equal(result.status, expected, name);
    if (name === 'unknown-retained') { assert.equal(result.trace.recovery_required, true); assert.equal(result.cleanup.removed, false); }
    if (name === 'unexpected-negative-save') { assert.equal(result.trace.saved_outputs.length, 1); assert.equal(result.trace.saved_outputs[0].verified, true); }
    results.push({ name, status: expected, reason: result.reason, recovery: result.trace?.recovery_required ?? false });
  }
  const meter = createMeter(offline, 'offline');
  const ledger = createLedger(meter); ledger.begin('root', 'user');
  ledger.record({ kind: 'raw', root: 'root', user: 'user', candidate: { decision: { action: 'delete', target: 'wrong' } } });
  ledger.record({ kind: 'permission', root: 'root', user: 'user', outcome: 'denied' });
  assert.equal(ledger.snapshot().events[0].candidate.decision.action, 'delete');
  assert.equal(ledger.snapshot().writes.length, 0);
  assert.throws(() => ledger.record({ kind: 'issued', root: 'root', user: 'forged' }), /stage_root_user_mismatch/);
  results.push({ name: 'denied-wrong-raw-retained-and-forged-stage-refused', status: 'verified' });
  return results;
}
module.exports = { adversaries, savedScenario, sourceMutations, offline };
