const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { CanaryBlocked } = require('./entry.cjs');
const { root } = require('./approval.cjs');
const { diagnostics } = require('./diagnostics.cjs');
const { establishPreload, isAuditedPreload } = require('./preload-decision.cjs');

const fixtureURL = pathToFileURL(path.join(__dirname, 'fixture.mjs')).href;

function environment(input, approval, paths, pure) {
  const permission = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', external_directory: 'deny',
    memocap_recall: { library: 'allow' }, memocap_read: { library: 'allow' }, memocap_remember: 'allow' };
  const config = { plugin: pure ? [] : [fixtureURL], instructions: [], mcp: {}, share: 'disabled', autoupdate: false,
    permission, agent: { build: { steps: 5 } }, provider: { 'openai-b1': { options: { maxRetries: 0 } } } };
  return { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8',
    HOME: paths.home, XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache, XDG_STATE_HOME: paths.state, TMPDIR: paths.tmp,
    OPENCODE_CONFIG: input.profileRef, OPENCODE_CONFIG_DIR: paths.config,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    MEMOCAP_DB: paths.database, MEMOCAP_BINARY: paths.launcher, MEMOCAP_CANARY_CONTROL: paths.control,
    MEMOCAP_CANARY_BATCH: approval.batch };
}

async function startHost({ input, approval, paths, pure, budget, preparation, ownership = { exited: true } }, dependencies = {}) {
  ownership.exited = true;
  budget.host(pure ? 'pure' : 'nonpure');
  const execute = dependencies.spawn ?? spawn;
  const env = environment(input, approval, paths, pure);
  const preload = (dependencies.preloadCheck ?? establishPreload)({ input, approval, paths, pure, preparation, env });
  if (!isAuditedPreload(preload, pure ? [] : [fixtureURL])) throw new CanaryBlocked('preload_preparation_required');
  budget.event({ kind: 'host.preload', pure, decision: preload });
  ownership.exited = false;
  const child = execute(approval.sandbox.path, ['-f', (pure ? approval.preflight_policy : approval.policy).path, approval.host.path,
    ...(pure ? ['--pure'] : []), 'serve', '--hostname=127.0.0.1', '--port=0', '--print-logs'],
  { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.once('close', () => { ownership.exited = true; resolve(); }));
  const signal = (value) => {
    try { if (child.pid) (dependencies.kill ?? process.kill)(-child.pid, value); else child.kill(value); }
    catch (error) { if (!(error instanceof Error) || error.code !== 'ESRCH') throw new CanaryBlocked('cleanup_signal_failed'); }
  };
  let url;
  let closing;
  const close = () => closing ??= (async () => {
    if (url && !pure) {
      try {
        await (dependencies.fetch ?? fetch)(`${url}/instance/dispose`, { method: 'POST',
          headers: { 'x-opencode-directory': paths.project }, signal: AbortSignal.timeout(3000) });
      } catch { budget.event({ kind: 'cleanup.dispose', status: 'failed' }); }
    }
    signal('SIGTERM');
    let timer;
    const forced = new Promise((resolve, reject) => { timer = setTimeout(() => {
      try { signal('SIGKILL'); resolve(exited); } catch (error) { reject(error); }
    }, 3000); });
    let deadline;
    try { await Promise.race([exited, forced, new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new CanaryBlocked('cleanup_exit_unknown')), 6000);
    })]); } finally { clearTimeout(timer); clearTimeout(deadline); }
    budget.event({ kind: 'cleanup.host_exit', pure });
  })();
  try {
    url = await new Promise((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => reject(new CanaryBlocked('host_start_timeout')), 20000);
      const fail = () => { clearTimeout(timer); reject(new CanaryBlocked('host_start_failed')); };
      child.once('error', fail); child.once('exit', fail);
      const receive = (chunk) => {
        buffered = (buffered + String(chunk)).slice(-8192);
        const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffered);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stdout.on('data', receive); child.stderr.on('data', receive);
    });
    const factory = dependencies.clientFactory ?? (await import('@opencode-ai/sdk')).createOpencodeClient;
    const client = factory({ baseUrl: url, directory: paths.project });
    const health = await client._client.get({ url: '/global/health' });
    if (health.error || health.data?.version !== '1.19.5') throw new CanaryBlocked('exact_host_mismatch');
    const [config, mcp] = await Promise.all([client.config.get(), client.mcp.status()]);
    if (config.error || mcp.error || !config.data) throw new CanaryBlocked('isolation_inspection_failed');
    const observation = diagnostics({ status: 200, result: config, mcpStatus: mcp, preload }, pure ? [] : [fixtureURL]);
    budget.event({ kind: 'host.isolation', pure, observation });
    if (!['declared_match_only', 'audited_preload_and_public_match'].includes(observation.isolation)) {
      throw new CanaryBlocked('isolation_unknown');
    }
    return { client, close, url };
  } catch (error) { await close(); throw error; }
}

module.exports = { environment, startHost, fixtureURL };
