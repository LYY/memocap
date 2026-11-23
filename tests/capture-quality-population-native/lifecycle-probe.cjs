const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { managedPaths } = require('../capture-quality-native/preload-decision.cjs');
const { selection } = require('./selected-provider-fixture.cjs');

function lifecycleProbe(options = {}) {
  const root = '/synthetic/private';
  const paths = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'tmp', 'project'].map((name) => [name, `${root}/${name}`]));
  Object.assign(paths, { settings: `${root}/settings.json`, database: `${root}/memory.sqlite`, socket: `${root}/control.sock` });
  const events = []; const configs = []; const rules = []; const probes = []; const retained = []; const charges = []; const pathRequests = [];
  const timers = new Map(); let serial = 0; let elapsed = 0; let checks = 0; let seeded = 0;
  const context = vm.createContext({ URL, Request, Buffer, AbortController, structuredClone,
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  const sdk = { path: { get: async (request) => { pathRequests.push(request);
    return options.instanceResponse ?? { data: { directory: paths.project, worktree: options.worktree ?? root } }; } },
    config: { get: async () => ({ data: configs.at(-1) }) }, session: {
    create: async () => ({ data: { id: 'actual-root' } }),
    update: async (request) => { rules.push(request.body.permission); return { data: { id: 'actual-root' } }; },
    prompt: async () => ({ data: {} }) } };
  const io = { writeFileSync(_file, bytes) { configs.push(JSON.parse(bytes)); }, chmodSync() {},
    existsSync(file) { probes.push(file); return file === options.present || options.appearAtSpawn && checks > 1 && file === managedPaths[0]; } };
  const dependencies = {
    'node:fs': io,
    'node:http': { createServer: () => { events.push('listener.create'); return { once() {},
      listen(_file, done) { events.push('listener.listen'); done(); },
      close(done) { events.push('listener.close'); if (!options.listenerHangs) done(options.listenerError); },
      closeAllConnections() { events.push('listener.destroy'); } }; } },
    './authorization.cjs': { assertAuthorization() {}, sources: () => ({ digest: 'offline-source' }) },
    './inventory.cjs': { caseLimits: require('./inventory.cjs').caseLimits },
    './owned.cjs': { owned: () => ({ paths, materialize() {}, preparation: { recheck() {
      checks++; events.push('preparation');
      if (options.stale) throw new Error('preload_discovery_changed');
      return options.malformed ? {} : { kind: 'owned-preload-v1', private_root: root, home: paths.home,
        config: paths.config, directories: [`${paths.config}/opencode`, paths.config], write_access: 'W_OK_denied' };
    } }, close(value) { events.push('owned.close'); retained.push(value);
      return { removed: value.exited === true && !value.retain_recovery, recovery_root: root }; } }) },
    './control.cjs': { control: () => ({ handler() {}, bind() {}, bindProvider() {},
      ready: Promise.resolve({ approval_id: 'offline-only', source_sha256: 'offline-source', captureExecutionMs: 30000, maintenanceExecutionMs: 30000 }),
      async call(method, value) {
        events.push(`plugin.${method}`);
        if (method === 'initialize') return { origin: `repository:${'b'.repeat(64)}` };
        if (method === 'seed') { const id = (options.seedID ?? 941) + 17 * seeded++;
          return { id, ...value, readback: { id, ...value } }; }
        if (method === 'close') {
          if (options.pluginHangs) return new Promise(() => {});
          if (options.pluginError) throw options.pluginError;
          return { children: 0, recovery_required: options.unknownWrite === true };
        }
        return {};
      }, stop() { events.push('control.stop'); if (options.controlHangs) return new Promise(() => {});
        if (options.controlError) throw options.controlError; } }) },
    './process.cjs': { launch: () => { events.push('launch');
      if (options.launchTrap) throw new Error('inert_launch_trap');
      return { ready: Promise.resolve(),
        closeEvidence: options.exited === false ? undefined : { leader_closed: true, pgid: 123, group_probe: 'ESRCH' },
        async close() { events.push('process.close');
        if (options.processHangs) return new Promise(() => {});
        if (options.processError) throw options.processError;
        return options.exited !== false;
      } };
    } },
  };
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const local = createRequire(filename);
    vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports', '__dirname'], {
      filename, parsingContext: context, importModuleDynamically: async (name) => {
        if (name === '../../plugin/maintenance/permission.js') return import(pathToFileURL(path.resolve(path.dirname(filename), name)).href);
        if (name !== '@opencode-ai/sdk') throw new Error('unexpected_dynamic_import');
        const imported = new vm.SyntheticModule(['createOpencodeClient'], function () { this.setExport('createOpencodeClient', () => sdk); }, { context });
        await imported.link(() => {}); await imported.evaluate(); return imported;
      } })(
      (name) => dependencies[name] ?? (name.startsWith('./') ? load(local.resolve(name)) : local(name)), module, module.exports, path.dirname(filename));
    return module.exports;
  }
  const { concreteHost } = load(path.join(__dirname, 'concrete-host.cjs'));
  const network_binding = selection();
  const host = concreteHost({ paths: { case_roots: [root], server: 'http://127.0.0.1:4444' },
    node: { path: '/synthetic/node' }, native: {}, host: { version: '1.19.5' }, profile: {}, endpoints: [network_binding.endpoint], network_binding },
  { approved: true, approval_id: 'offline-only', network_binding }, options.id ?? 'read-route', 0);
  async function settle(action) {
    let result; let failure; let done = false;
    action.then((value) => { result = value; done = true; }, (error) => { failure = error; done = true; });
    for (let step = 0; step < 30 && !done; step++) {
      for (let microtask = 0; microtask < 40; microtask++) await Promise.resolve();
      if (done || !timers.size) break;
      const [id, timer] = [...timers].sort((left, right) => left[1].delay - right[1].delay)[0];
      timers.delete(id); elapsed += timer.delay; timer.callback();
    }
    for (let microtask = 0; microtask < 40; microtask++) await Promise.resolve();
    if (failure) throw failure;
    return { done, result, elapsed, remainingTimers: timers.size };
  }
  return { host, configs, rules, events, probes, retained, settle, managedPaths, charges, pathRequests,
    open: () => host.open({ charge: (...args) => charges.push(args), signal: new AbortController().signal, approval: { approval_id: 'offline-only' } }) };
}
module.exports = { lifecycleProbe };
