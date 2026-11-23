const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL, fileURLToPath } = require('node:url');

async function productionProbe(overrides = {}) {
  const defaults = [];
  const context = vm.createContext({ console, Buffer, URL, TextDecoder, TextEncoder, AbortSignal, AbortController, structuredClone,
    setTimeout, clearTimeout, process: { env: { HOME: '/synthetic/home', MEMOCAP_DB: '/synthetic/memory.db' },
      platform: process.platform, cwd: () => '/synthetic/project' } });
  const modules = new Map();
  async function moduleFor(specifier, parent = pathToFileURL(__filename).href) {
    const url = specifier.startsWith('.') ? new URL(specifier, parent).href : specifier;
    if (modules.has(url)) return modules.get(url);
    let module;
    if (!url.startsWith('file:')) {
      const imported = url === 'node:perf_hooks' && overrides.performance ? { performance: overrides.performance } : await import(url);
      module = new vm.SyntheticModule(Object.keys(imported), function () {
        for (const [name, value] of Object.entries(imported)) this.setExport(name, value);
      }, { context, identifier: url });
    } else if (url.endsWith('/plugin/bridge.js')) {
      module = new vm.SyntheticModule(['run', 'BridgeError'], function () {
        this.setExport('run', async () => { defaults.push('default'); throw new Error('default_bridge_forbidden'); });
        this.setExport('BridgeError', class BridgeError extends Error {});
      }, { context, identifier: url });
    } else {
      module = new vm.SourceTextModule(fs.readFileSync(fileURLToPath(url), 'utf8'), { context, identifier: url,
        initializeImportMeta(meta) { meta.url = url; } });
    }
    modules.set(url, module);
    return module;
  }
  let loading = Promise.resolve();
  async function loadOne(specifier) {
    const module = await moduleFor(specifier, pathToFileURL(path.join(__dirname, 'production-factory.cjs')).href);
    if (module.status === 'unlinked') await module.link((name, parent) => moduleFor(name, parent.identifier));
    if (module.status === 'linked') await module.evaluate();
    return module;
  }
  const load = (specifier) => {
    const result = loading.then(() => loadOne(specifier));
    loading = result.then(() => undefined);
    return result;
  };
  const exported = { exports: {} };
  const filename = path.join(__dirname, 'production-factory.cjs');
  const execute = vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], {
    parsingContext: context, filename, importModuleDynamically: load });
  execute(require, exported, exported.exports);
  return { factory: exported.exports.productionFactory, defaults, load };
}
module.exports = { productionProbe };
