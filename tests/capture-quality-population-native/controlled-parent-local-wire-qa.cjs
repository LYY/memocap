const path = require('node:path');
const assert = require('node:assert/strict');
const profile = 'controlled_native_parent_genuine_curator_v1';
const endpoint = 'https://controlled-wire.invalid/v1/responses';
const origin = `repository:${'b'.repeat(64)}`;
const root = path.resolve(__dirname, '../..');
const hostPath = '/opt/homebrew/bin/opencode';
const nodePath = '/opt/homebrew/Cellar/node/26.13.0_2/bin/node';
const hostHash = 'feaafead8cd563af0c2dcb386b0757e4355e327ebb6bd1aaad5440fe2f83596c';
const nodeHash = '3b78c226730ec2d7b65704113f63ce3c04a8168cdf990390ec3adfc0a356d87f';
function describe() {
  return { status: 'NOT_RUN', profile, scope: 'native Read and installed Responses decoder only',
    product_plugin: false, genuine_quality: false, external_requests: 0, memocap_native: 0,
    caps: { serves: 1, scripted_generations: 16, runtime_ms: 90000, teardown_ms: 6000 },
    fixture_repair: { status: 'UNEXERCISED', scenarios: ['negative', 'recall', 'invalid', 'secret'],
      command: `${nodePath} ${__filename} --run-fixture-wire negative ${root}/.omo/evidence/capture-expansion/controlled-parent-local-wire-actual-fixture-negative-v1.json` },
    command: `${nodePath} ${__filename} --run-local-wire ${root}/.omo/evidence/capture-expansion/controlled-parent-local-wire-actual-prepared-v1.json` };
}
async function installProtocol(input, options) {
  const { install } = require('./plugin-runtime.cjs');
  const { createFixture } = require('./fixture.cjs');
  const originalFetch = globalThis.fetch;
  const localFetch = (target, init) => {
    const request = new Request(target, init);
    assert.equal(new URL(request.url).origin, input.serverUrl.origin, 'external_transport_refused');
    return originalFetch(new Request(request, { redirect: 'error', signal: AbortSignal.any([
      request.signal, AbortSignal.timeout(10000) ]) }));
  };
  globalThis.fetch = localFetch;
  if (options.fixture_wire) {
    let charge;
    const native = await require('./curator-fixture-wire.cjs').wireNative(options, (...args) => charge(...args));
    return install(input, options, { fetch: localFetch, native,
      fixture: (actual, seam) => { charge = seam.charge; return createFixture(actual, seam); } });
  }
  return install(input, options, { fetch: localFetch,
    native: { initialize: async () => origin, uncertain: () => false,
      invoke() { assert.fail('memocap_native_forbidden'); }, seed() { assert.fail('seed_forbidden'); } },
    fixture: (actual, seam) => createFixture(actual, { ...seam, factory: async () => ({ dispose() {} }) }) });
}
async function run(reportFile, scenario) {
  assert.equal(path.dirname(reportFile), path.join(root, '.omo/evidence/capture-expansion'));
  assert.match(path.basename(reportFile), /^controlled-parent-local-wire-actual-[A-Za-z0-9_-]+\.json$/);
  const fs = require('node:fs');
  const { createHash, randomUUID } = require('node:crypto');
  const { pathToFileURL } = require('node:url');
  const { once } = require('node:events');
  const http = require('node:http');
  const net = require('node:net');
  const { spawn } = require('node:child_process');
  const { launch } = require('./process.cjs');
  const { control } = require('./control.cjs');
  const { owned } = require('./owned.cjs');
  const { cleanupOwned } = require('./cleanup.cjs');
  const { sources } = require('./authorization.cjs');
  const { fixturePermissions, validateInstancePath } = require('./permission-configuration.cjs');
  const { boundSDK } = require('./sdk-boundary.cjs');
  const { portClosed } = require('../opencode-v1/host.cjs');
  const hashFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const report = { ...describe(), status: 'WORKING', actual_execution: 'STARTING',
    journal: [], used: {}, owned: { pids: [], ports: [] }, quality_credit: false };
  if (scenario) Object.assign(report, { scenario, product_plugin: true, memocap_native: 'injected_only', scope: 'production tool conformance with injected native adapter', events: [] });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const save = () => fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const journal = (kind, details = {}) => { report.journal.push({ kind, ...details }); save(); };
  const started = performance.now();
  const deadline = AbortSignal.timeout(90000);
  const bounded = (promise) => new Promise((resolve, reject) => {
    const abort = () => reject(deadline.reason);
    deadline.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => deadline.removeEventListener('abort', abort));
    if (deadline.aborted) abort();
  });
  let privateState; let listener; let channel; let host; let child; let reservation; let server; let session; let sdk;
  let exited = false; let timer; let complete; let tool;
  try {
    if (scenario === 'secret') {
      let opens = 0;
      report.screen = await require('./adapter.cjs').runCase('synthetic-secret', { budget: { mode: 'offline', approved: false },
        host: { mode: 'offline', open() { opens++; assert.fail('secret_reached_host'); } } });
      assert.equal(report.screen.status, 'wired'); assert.equal(report.screen.turns[0].status, 'screened_whole_unit');
      assert.equal(opens, 0); assert.deepEqual(report.screen.budget_used, {}); assert.deepEqual(report.screen.custody, []);
      assert.deepEqual(report.screen.completion_evidence, []); assert.equal(report.screen.trace, null);
      assert.equal(report.screen.transport, null); report.actual_execution = 'PASS_WHOLE_SECRET_PREFLIGHT_ONLY';
    } else {
    assert.equal(process.execPath, nodePath); assert.equal(hashFile(nodePath), nodeHash);
    assert.equal(hashFile(hostPath), hostHash);
    const sourceIdentity = sources(); report.source_sha256 = sourceIdentity.digest;
    const parent = fs.realpathSync('/var/folders/x_/n5qr2_211jg2j9_7q_gdxw940000gn/T/opencode');
    const privateRoot = path.join(parent, `controlled-wire-${randomUUID()}`);
    journal('reserve_private_root', { privateRoot });
    privateState = owned(privateRoot); const paths = privateState.paths;
    const source = path.join(paths.project, `${randomUUID()}.data`);
    const body = 'CONTROLLED_NATIVE_READ_ALPHA\nCONTROLLED_NATIVE_READ_BRAVO\n';
    const operation = { token: 'owned-source', tool: 'read', input: { filePath: source } };
    const translation = { files: [{ path: source, bytes: body }] };
    const token = randomUUID(); channel = control(token);
    channel.bind({ charge(key, amount = 1) {
      assert.ok(Number.isSafeInteger(amount) && amount >= 0);
      const cap = key.startsWith('scripted_root_') && !key.endsWith('_bytes') ? 16 :
        key.endsWith('_bytes') || key === 'control_bytes' ? 16777216 : 256;
      const total = (report.used[key] ?? 0) + amount;
      assert.ok(total <= cap, 'local_budget');
      assert.ok(!['requests', 'parent_requests', 'worker_requests', 'provider_requests', ...(scenario ? [] : ['native_calls', 'native_processes'])].includes(key), 'paid_or_native_refused');
      report.used[key] = total;
    }, user(value) { report.user_id = value.message.id; },
    prepare(value) { assert.equal(value, operation.token); return translation; },
    tool(value) { assert.equal(tool, undefined); tool = value; },
    complete(value) { complete = value; }, record(event) { assert.ok(scenario, 'product_observation_forbidden'); report.events.push(event); } }, privateState.materialize);
    journal('reserve_control_listener'); listener = http.createServer(channel.handler);
    await bounded(new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(paths.socket, resolve); }));
    fs.chmodSync(paths.socket, 0o600);
    journal('reserve_host_port'); reservation = net.createServer(); reservation.listen(0, '127.0.0.1');
    await bounded(once(reservation, 'listening')); const port = reservation.address().port;
    await bounded(new Promise((resolve) => reservation.close(resolve))); server = `http://127.0.0.1:${port}`;
    report.owned.ports = [server];
    const entry = path.join(privateRoot, 'protocol.mjs');
    fs.writeFileSync(entry, `import driver from ${JSON.stringify(pathToFileURL(__filename).href)};\nexport default { id: 'controlled-parent-read-protocol', server: driver.installProtocol };\n`, { flag: 'wx', mode: 0o600 });
    const options = { kind: 'quality-full-population-plugin-v1', approval_id: 'controlled-read-conformance',
      source_sha256: sourceIdentity.digest, case: 'same-task-third-turn', privateRoot, paths,
      socket: paths.socket, token, endpoints: [endpoint], execution_profile: profile };
    if (scenario) {
      options.fixture_wire = scenario; options.case = require('./curator-fixture-wire.cjs').scenarios[scenario];
      fs.writeFileSync(paths.database, '', { flag: 'wx', mode: 0o600 });
    }
    const config = { model: 'openai-b1/gpt-6.1-sol', small_model: 'openai-b1/gpt-6.1-sol',
      enabled_providers: ['openai-b1'], share: 'disabled', autoupdate: false, snapshot: false, mcp: {},
      permission: { '*': 'deny', read: 'deny', external_directory: 'deny' },
      plugin: [[pathToFileURL(entry).href, options]],
      provider: { 'openai-b1': { npm: '@ai-sdk/openai', name: 'Controlled local Responses only',
        options: { baseURL: 'https://controlled-wire.invalid/v1', apiKey: 'local-fixture-only', maxRetries: 0, timeout: 10000 },
        models: { 'gpt-6.1-sol': { name: 'Controlled fixture', tool_call: true,
          limit: { context: 64000, output: 1024 }, cost: { input: 0, output: 0 } } } } } };
    fs.writeFileSync(paths.settings, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    const environment = { HOME: paths.home, XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.data,
      XDG_CACHE_HOME: paths.cache, XDG_STATE_HOME: paths.state, TMPDIR: paths.tmp,
      MEMOCAP_DB: paths.database,
      PATH: `${path.dirname(nodePath)}:/usr/bin:/bin`, OPENCODE_CONFIG_DIR: paths.config, OPENCODE_CONFIG: paths.settings,
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', OPENCODE_DISABLE_AUTOCOMPACT: 'true',
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true' };
    journal('reserve_host_process', { serves: 1 });
    host = launch({ host: { path: hostPath }, server, project: paths.project, environment }, { spawn(binary, args, spawnOptions) {
      child = spawn(binary, args, spawnOptions); report.owned.pids = [child.pid];
      child.once('close', () => { exited = true; }); return child;
    } });
    timer = setTimeout(() => { if (!exited) process.kill(-child.pid, 'SIGTERM'); }, Math.max(1, 90000 - (performance.now() - started)));
    await bounded(host.ready);
    const { createOpencodeClient } = await import('@opencode-ai/sdk');
    const client = createOpencodeClient({ baseUrl: server, directory: paths.project, fetch(target, init) {
      const request = new Request(target, init); assert.equal(new URL(request.url).origin, server);
      return fetch(new Request(request, { redirect: 'error', signal: AbortSignal.any([request.signal, deadline]) }));
    } });
    const charge = () => {};
    sdk = boundSDK(client, charge);
    const instance = await bounded(boundSDK({ _client: client.path }, charge)._client.get({ query: { directory: paths.project } }));
    assert.ok(!instance.error); assert.equal(instance.data.directory, paths.project);
    validateInstancePath({ root: paths.project, worktree: instance.data.worktree });
    const joined = await bounded(channel.ready); assert.equal(joined.source_sha256, sourceIdentity.digest);
    const created = await bounded(sdk.session.create({ body: { title: 'Controlled Read Responses conformance' } }));
    assert.ok(!created.error && created.data.id); session = created.data.id;
    const prepared = scenario ? await require('./curator-fixture-wire.cjs').wirePacket(scenario, { session, operation, call: (method, value) => bounded(channel.call(method, value)) }) : null;
    const packet = prepared?.packet ?? { root: session, user: 'Read the supplied synthetic source once.', operations: [operation], memories: [], review: false };
    report.seed_bindings = prepared?.seeds ?? [];
    const configured = await fixturePermissions(options.case, { root: paths.project, worktree: instance.data.worktree, origin, database: paths.database }, report.seed_bindings);
    const rules = configured.root(packet).filter((rule) => scenario || !rule.permission.startsWith('memocap_'));
    if (scenario) await require('./curator-fixture-wire.cjs').verifyPermissions(scenario,
      { configured, rules, database: paths.database, seeds: prepared.seeds });
    const updated = await bounded(sdk.session.update({ path: { id: session }, body: { permission: rules } }));
    assert.ok(!updated.error); assert.deepEqual(updated.data.permission, rules);
    report.permission = rules; await bounded(channel.call('bind', packet));
    const response = await bounded(sdk.session.prompt({ path: { id: session }, body: {
      model: { providerID: 'openai-b1', modelID: 'gpt-6.1-sol' }, parts: [{ type: 'text', text: packet.user }] } }));
    if (scenario) {
      if (scenario === 'invalid') assert.ok(response.error || response.data?.info.error, 'invalid_receipt_must_stop');
      else assert.ok(!response.error && !response.data.info.error && response.data.info.finish === 'stop');
      const settled = await bounded(channel.call('wait', { review: false, seed_bindings: prepared.seeds }));
      report.final_seed_state = settled.final_seed_state; report.resources = settled.resources;
      require('./curator-fixture-wire.cjs').verifyWire(scenario, report);
      report.actual_execution = 'PASS_FIXTURE_CONFORMANCE_ONLY';
    } else {
    assert.ok(!response.error && !response.data.info.error); assert.equal(response.data.info.finish, 'stop');
    await bounded(channel.call('wait', { review: false }));
    assert.equal(tool.part.tool, 'read'); assert.equal(tool.part.state.status, 'completed');
    assert.deepEqual(tool.part.state.input, operation.input);
    for (const line of body.trim().split('\n')) assert.ok(tool.part.state.output.includes(line));
    assert.ok(response.data.parts.some((part) => part.type === 'text' && part.text.length > 0));
    assert.equal(complete.finish, 'stop'); assert.equal(complete.id, response.data.info.id);
    assert.equal(report.used.scripted_root_dispatches, 2); assert.equal(report.used.scripted_root_generations, 2);
    report.actual_execution = 'PASS_READ_RESPONSES_CONFORMANCE_ONLY';
    report.observed = { session, call_id: tool.part.callID, tool_status: tool.part.state.status, finish: complete.finish,
      terminal_id: complete.id, continuations: 1, product_plugin: false };
    }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    report.actual_execution = 'UNPROVEN'; report.failure = { name: error.name, code: error.code ?? 'conformance_failed' };
  } finally {
    clearTimeout(timer); journal('begin_teardown');
    const cleanup = await cleanupOwned({ adapter: session && { close: () => channel.call('close', { session }) },
      process: host, channel, listener }, { retain_recovery: true });
    if (reservation?.listening) await new Promise((resolve) => reservation.close(resolve));
    let groupAbsent = !child;
    if (child) try { process.kill(-child.pid, 0); } catch (error) {
      if (error.code === 'ESRCH') groupAbsent = true;
      else report.group_probe_error = error instanceof Error ? error.code ?? error.name : 'group_probe_failed';
    }
    const portAbsent = server ? await portClosed(server) : true;
    report.cleanup = { ...cleanup, group_absent: groupAbsent, port_closed: portAbsent };
    if (privateState) report.private = privateState.close({ exited: cleanup.exited && groupAbsent && portAbsent,
      retain_recovery: Boolean(cleanup.error) });
    report.owned.pids = groupAbsent ? [] : report.owned.pids; report.owned.ports = portAbsent ? [] : report.owned.ports;
    if (!cleanup.exited || !groupAbsent || !portAbsent || cleanup.error) report.actual_execution = 'UNPROVEN';
    report.status = report.actual_execution.startsWith('PASS_') ? 'PASS' : 'UNPROVEN';
    report.elapsed_ms = Math.round(performance.now() - started); save();
  }
  return { status: report.status, actual_execution: report.actual_execution, report: reportFile };
}
async function main(args) {
  if (args.length === 0 || args.length === 1 && ['--help', '--describe'].includes(args[0])) return describe();
  if (args.length === 3 && args[0] === '--run-fixture-wire') {
    assert.ok(args[1] === 'secret' || Object.hasOwn(require('./curator-fixture-wire.cjs').scenarios, args[1]), 'wire_scenario'); return run(args[2], args[1]);
  }
  assert.ok(args.length === 2 && args[0] === '--run-local-wire', 'explicit_run_and_fresh_report_required');
  return run(args[1]);
}
if (require.main === module) main(process.argv.slice(2)).then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`); if (result.status === 'UNPROVEN') process.exitCode = 1;
}).catch((error) => { process.stderr.write(`${error instanceof Error ? error.code ?? error.name : 'driver_failed'}\n`); process.exitCode = 1; });
module.exports = { describe, main, installProtocol };
