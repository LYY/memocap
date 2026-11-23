const { TransportBlocked } = require('./value.cjs');

async function cleanupOwned(state, request) {
  const failures = [];
  async function phase(name, action, timeout) {
    let timer;
    try {
      const value = await Promise.race([Promise.resolve().then(action), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new TransportBlocked(`${name}_timeout`)), timeout);
      })]);
      return { known: true, value };
    } catch (cause) {
      failures.push(cause instanceof TransportBlocked ? cause.code : `${name}_failed`);
      return { known: false };
    } finally { clearTimeout(timer); }
  }
  const plugin = await phase('plugin_close', () => state.adapter?.close(request), 400);
  const process = await phase('process_close', () => state.process ? state.process.close() : true, 2100);
  const exited = process.known && process.value === true;
  const processEvidence = state.process?.closeEvidence;
  const groupAbsent = !state.process || (processEvidence?.leader_closed === true && processEvidence.group_probe === 'ESRCH');
  if (exited && !groupAbsent) failures.push('process_group_unconfirmed');
  const control = await phase('control_stop', () => state.channel?.stop(), 50);
  const listener = await phase('listener_close', () => state.listener ? new Promise((resolve, reject) => {
    state.listener.close((error) => error ? reject(error) : resolve());
    state.listener.closeAllConnections?.();
  }) : undefined, 200);
  let owned;
  try {
    owned = state.private?.close({ exited, retain_recovery: request.retain_recovery ||
      plugin.value?.recovery_required || !exited || failures.length > 0 });
  } catch (cause) {
    failures.push(cause instanceof TransportBlocked ? cause.code : 'owned_close_failed');
    owned = { removed: false, recovery_root: state.private?.paths.home && require('node:path').dirname(state.private.paths.home) };
  }
  return { ...owned, exited, children: exited && groupAbsent ? 0 : null, control_stopped: control.known, listener_closed: listener.known,
    ...(processEvidence ? { process_evidence: processEvidence } : {}),
    ...(failures.length ? { error: failures[0], cleanup_errors: failures } : {}) };
}
module.exports = { cleanupOwned };
