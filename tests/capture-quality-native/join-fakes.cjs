const { digest, receipt } = require('./projection.cjs');
const { memoryReceipt } = require('./receipt-fakes.cjs');

function joined() {
  const expected = 'synthetic frozen source';
  const carrier = '/owned/project/docs/route.md';
  const messages = [{ info: { id: 'user', sessionID: 'root', role: 'user' }, parts: [] },
    { info: { id: 'answer', sessionID: 'root', parentID: 'user', role: 'assistant', finish: 'stop' }, parts: [{
      id: 'read-part', type: 'tool', callID: 'read-call', tool: 'read', state: { status: 'completed', input: { filePath: carrier } } }] }];
  const native = memoryReceipt();
  native.caller.session_id = 'commit';
  const full = receipt(memoryReceipt('read'));
  const projected = receipt({ ...native, readback: memoryReceipt('read') });
  const events = [{ kind: 'capture.packet', root: 'root', session: 'extract', packet: { current_user_id: 'user',
    sources: [{ source_id: 'read-source', kind: 'file_content', tool_id: 'read', user_id: 'user', completeness: 'full',
      text: expected, content_hash: digest(expected), pointer: { locator: carrier }, message_id: 'answer', part_id: 'read-part', call_id: 'read-call' }],
    bundles: [{ source_id: 'read-source', user_id: 'user', units: [{ content_hash: digest(expected), text: expected,
      span: { start: 0, end: Array.from(expected).length } }] }] } },
  { kind: 'tool.receipt', tool: 'memocap_remember', root: 'root', session: 'commit', message: 'commit-user', receipt: projected },
  { kind: 'native.ask', permission: 'memocap_remember', session: 'commit', message: 'commit-user', outcome: 'resolved' },
  { kind: 'native.receipt', command: 'remember', exit_code: 0, session: 'commit', message: 'commit-user', receipt: receipt(native) },
  { kind: 'independent.readback', write_operation_id: native.operation_id, exit_code: 0, receipt: full },
  { kind: 'native.tool_before', session: 'commit', call: 'commit-call', tool: 'memocap_remember' },
  { kind: 'native.event', type: 'message.part.updated', session: 'commit', message: 'commit-user',
    part: 'commit-part', call: 'commit-call', tool: 'memocap_remember', status: 'completed' }];
  const bindings = { roots: { root: 'root:user' }, reviews: { 'root:user': { session: 'root', user: 'user' } }, sessions: {
    root: { root: 'root', review: null }, extract: { root: 'root', review: 'root:user', stage: 'extract' },
    commit: { root: 'root', review: 'root:user', stage: 'commit' } } };
  return { events, messages, expected, carrier, session: 'root', bindings };
}

module.exports = { joined };
