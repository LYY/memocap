const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { SharedBudget } = require('./journal.cjs');
const { receipt, digest, writeReceipt } = require('./projection.cjs');
const { CanaryBlocked } = require('./entry.cjs');

function commandOf(argv) {
  for (let index = 0; index < argv.length; index++) {
    if (['--repo', '--repository-id', '--caller-json', '--config'].includes(argv[index])) { index++; continue; }
    if (argv[index] === '--version') return '--version';
    if (!argv[index].startsWith('-')) return argv[index];
  }
  throw new CanaryBlocked('unknown_native_command');
}

function invokeNative(argv, settings, dependencies = {}) {
  const budget = dependencies.budget ?? new SharedBudget(settings.attempt);
  const execute = dependencies.execute ?? spawnSync;
  const command = commandOf(argv);
  const callerAt = argv.indexOf('--caller-json');
  const caller = callerAt >= 0 ? JSON.parse(argv[callerAt + 1]) : {};
  const payloadAt = argv.indexOf('--payload');
  const payload = payloadAt >= 0 ? JSON.parse(argv[payloadAt + 1]) : null;
  const terminal = command === 'activity' && payload?.detail?.phase === 'capture_review';
  const setup = dependencies.setup === true;
  const organization = command === 'organize' ? argv[argv.indexOf(command) + 1] : null;
  const writing = command === 'remember' || organization === 'maintain';
  const writeAttempt = writing ? budget.write(caller.session_id, setup) : null;
  if (!writing && (!['--version', 'read', 'list', 'recall', 'status', 'activity', 'scope', 'organize'].includes(command) ||
      command === 'organize' && organization !== 'read' ||
      command === 'scope' && argv[argv.indexOf(command) + 1] !== 'resolve' ||
      command === 'activity' && !['record', 'show', 'list'].includes(argv[argv.indexOf(command) + 1]))) {
    budget.stop('unexpected_write'); throw new CanaryBlocked('unexpected_write');
  }
  if (!terminal && budget.snapshot().terminal) throw new CanaryBlocked(budget.snapshot().terminal);
  budget.event({ kind: 'native.dispatch', command, organization, session: caller.session_id ?? null,
    message: caller.message_id ?? null, setup, writing, write_attempt: writeAttempt,
    request_hash: dependencies.stdin ? digest(dependencies.stdin) : null });
  if (writing) budget.dispatchWrite(writeAttempt, { command, session: caller.session_id ?? null, message: caller.message_id ?? null });
  let result;
  try { result = execute(settings.nativeBinary, argv, { cwd: settings.root, env: dependencies.env,
    input: dependencies.stdin, encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 }); }
  catch {
    budget.stop(writing ? 'native_write_unknown' : 'native_operation_failed');
    throw new CanaryBlocked(writing ? 'native_write_unknown' : 'native_operation_failed');
  }
  if (result.error || result.signal) {
    budget.stop(writing ? 'native_write_unknown' : 'native_operation_failed');
    throw new CanaryBlocked(writing ? 'native_write_unknown' : 'native_operation_failed');
  }
  let parsed;
  if (command !== '--version') {
    let projected;
    try {
      parsed = JSON.parse(result.stdout);
      if (writing && result.status !== 0) throw new CanaryBlocked('native_write_failed');
      projected = writing ? writeReceipt(parsed, { command, caller }) : receipt(parsed);
    }
    catch { budget.stop('native_receipt_invalid'); throw new CanaryBlocked('native_receipt_invalid'); }
    if (writing) budget.recordWrite(writeAttempt, projected);
    budget.event({ kind: 'native.receipt', command, session: caller.session_id ?? null,
      message: caller.message_id ?? null, setup, exit_code: result.status, write_attempt: writeAttempt, receipt: projected });
  }
  if (terminal) budget.event({ kind: 'capture.terminal', session: payload.context?.session_id ?? caller.session_id,
    user: payload.context?.message_id ?? caller.message_id, ...payload.detail.metadata,
    activity_operation_id: parsed.operation_id ?? null, activity_exit: result.status });
  if (parsed?.status === 'denied' || parsed?.error?.code === 'permission_denied') budget.stop('permission_denied');
  return result;
}

function main() {
  try {
    const settings = JSON.parse(fs.readFileSync(process.env.MEMOCAP_CANARY_CONTROL, 'utf8'));
    const args = process.argv.slice(2);
    const result = invokeNative(args, settings, { env: process.env,
      stdin: commandOf(args) === 'organize' ? fs.readFileSync(0, 'utf8') : undefined });
    process.stdout.write(result.stdout);
    process.exitCode = result.status ?? 2;
  } catch (error) {
    process.stderr.write(`${error instanceof CanaryBlocked ? error.code : 'native_proxy_failed'}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();
module.exports = { invokeNative, commandOf, main };
