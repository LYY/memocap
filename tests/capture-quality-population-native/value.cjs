const { createHash } = require('node:crypto');
const startupCategories = Object.freeze(['sandbox_message', 'permission_message', 'address_in_use_message']);
const startupSignals = Object.freeze(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
  'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM']);
function startupDiagnostics(summary) {
  const capped = (value) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 4097) : 0;
  return Object.freeze({ exit_observed: summary.exit_observed === true,
    exit_code: Number.isInteger(summary.exit_code) ? summary.exit_code : null,
    exit_signal: summary.exit_signal == null ? null : startupSignals.includes(summary.exit_signal) ? summary.exit_signal : 'other',
    readiness: ['matched', 'mismatch'].includes(summary.readiness) ? summary.readiness : 'not_seen',
    stdout_bytes_capped: capped(summary.stdout_bytes_capped), stderr_bytes_capped: capped(summary.stderr_bytes_capped),
    stderr_truncated: summary.stderr_truncated === true,
    stderr_categories: Object.freeze(startupCategories.filter((category) => summary.stderr_categories.includes(category))) });
}
class TransportBlocked extends Error {
  constructor(code, summary) {
    super(code); this.name = 'TransportBlocked'; this.code = code;
    if (summary !== undefined) Object.defineProperty(this, 'startup_diagnostics', {
      value: startupDiagnostics(summary), enumerable: true });
  }
}
const requireStage = (condition, code) => { if (!condition) throw new TransportBlocked(code); };
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const size = (value) => Buffer.byteLength(JSON.stringify(value));
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
async function bounded(action, timeout, controller) {
  let timer;
  try {
    return await Promise.race([action(), new Promise((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new TransportBlocked('host_boundary_timeout')); }, timeout);
    })]);
  } finally { clearTimeout(timer); }
}
module.exports = { TransportBlocked, requireStage, hash, size, identifier, bounded, startupDiagnostics };
