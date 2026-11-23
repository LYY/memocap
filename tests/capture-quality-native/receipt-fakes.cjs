const { version } = require('../../package.json');
const placement = `repository:${'a'.repeat(64)}`;
const operation = '11111111-1111-4111-8111-111111111111';

function memoryReceipt(command = 'remember') {
  return { format_version: 1, package_version: version, operation: command,
    operation_id: command === 'read' ? '22222222-2222-4222-8222-222222222222' : operation,
    status: command === 'read' ? 'ok' : 'inserted', backend: 'local', origin: 'cli',
    caller: { actor: 'plugin', session_id: 'session-1-commit', message_id: 'commit-user' },
    targets: [{ canonical_path: null, repository_id: placement, placements: [placement] }],
    searched_placements: [placement], returned_ids: [4], truncated: false,
    activity_status: 'not_requested', error: null, results: [{ source_order: 0,
      visibility: 'source', applicable_repositories: [], memory: { id: 4, placement,
        content: 'offline synthetic content', tags: 'synthetic' } }] };
}

function successfulResult(value) { return { status: 0, signal: null, stdout: JSON.stringify(value) }; }

module.exports = { memoryReceipt, successfulResult, placement, operation };
