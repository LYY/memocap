const { spawn } = require('node:child_process');
const { TransportBlocked } = require('./value.cjs');
function launch(settings, dependencies = {}) {
  const execute = dependencies.spawn ?? spawn;
  const url = new URL(settings.server);
  const child = execute(settings.host.path, ['serve', '--hostname=127.0.0.1', `--port=${url.port}`], { cwd: settings.project, env: settings.environment,
    shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pgid = Number.isInteger(child.pid) && child.pid > 1 && child.pid <= 0x7fffffff ? child.pid : null;
  const signalGroup = dependencies.kill ?? ((pid, signal) => process.kill(-pid, signal));
  const exit = Promise.withResolvers();
  let leaderExited = false;
  let observedExit = false;
  let exitCode = null;
  let exitSignal = null;
  child.once('exit', () => { leaderExited = true; });
  child.once('close', (code, signal) => {
    observedExit = true; exitCode = code; exitSignal = signal; exit.resolve(true);
  });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    let terminal = false;
    let readiness = 'not_seen';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overlap = '';
    const categories = new Set();
    const tokens = [['sandbox-exec:', 'sandbox_message'], ['EACCES', 'permission_message'],
      ['EPERM', 'permission_message'], ['EADDRINUSE', 'address_in_use_message']];
    const timer = setTimeout(() => finish('host_start_deadline'), 30000);
    const finish = (code) => {
      if (terminal) return;
      terminal = true; clearTimeout(timer);
      const summary = { exit_observed: observedExit, exit_code: exitCode, exit_signal: exitSignal, readiness,
        stdout_bytes_capped: stdoutBytes, stderr_bytes_capped: stderrBytes,
        stderr_truncated: stderrBytes > 4096, stderr_categories: [...categories] };
      output = ''; overlap = '';
      code ? reject(new TransportBlocked(code, summary)) : resolve();
    };
    function data(chunk) {
      if (terminal) return;
      stdoutBytes = Math.min(4097, stdoutBytes + chunk.length);
      output += chunk.subarray(0, 4097).toString('utf8');
      if (Buffer.byteLength(output) > 4096) { finish('host_start_output_budget'); return; }
      const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) {
        readiness = match[1] === settings.server.replace(/\/$/, '') ? 'matched' : 'mismatch';
        finish(readiness === 'matched' ? null : 'host_endpoint_mismatch');
      }
    }
    child.stdout.on('data', data);
    child.stderr.on('data', (chunk) => {
      if (terminal) return;
      const remaining = Math.max(0, 4096 - stderrBytes);
      stderrBytes = Math.min(4097, stderrBytes + chunk.length);
      if (remaining === 0) return;
      const text = overlap + chunk.subarray(0, remaining).toString('latin1');
      for (const [token, category] of tokens) if (text.includes(token)) categories.add(category);
      overlap = text.slice(-12);
    });
    child.on('error', () => finish('host_spawn_failed'));
    child.once('close', () => finish('host_exited_before_ready'));
  });
  let closing;
  let closeEvidence;
  return { ready, get closeEvidence() { return closeEvidence; }, close() {
    closing ??= closeOnce();
    return closing;
  } };

  async function closeOnce() {
    const deadline = performance.now() + 2000;
    let termError;
    // Once the leader has exited, its numeric PGID is safe to probe only.
    if (pgid !== null && !leaderExited && !observedExit) {
      try { signalGroup(pgid, 'SIGTERM'); } catch (error) {
        if (error?.code !== 'ESRCH') termError = error?.code === 'EPERM' ? 'EPERM' : 'unknown';
      }
    }
    if (termError) {
      closeEvidence = Object.freeze({ leader_closed: observedExit, pgid, group_probe: 'not_probed', term_error: termError });
      throw new TransportBlocked('process_group_term_failed');
    }
    let timer;
    const leaderClosed = await Promise.race([exit.promise, new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
    })]);
    clearTimeout(timer);
    let groupProbe = 'not_probed';
    if (leaderClosed && pgid !== null) {
      while (performance.now() < deadline) {
        try {
          signalGroup(pgid, 0);
          groupProbe = 'present';
        } catch (error) {
          groupProbe = error?.code === 'ESRCH' ? 'ESRCH' : error?.code === 'EPERM' ? 'EPERM' : 'unknown';
          break;
        }
        const remaining = deadline - performance.now();
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
      }
    }
    closeEvidence = Object.freeze({ leader_closed: leaderClosed, pgid, group_probe: groupProbe });
    return leaderClosed;
  }
}
module.exports = { launch };
