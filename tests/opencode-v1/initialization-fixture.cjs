const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runner, isolatedEnvironment, terminate } = require('../packaged-runtime.cjs');
const host = require('./host.cjs');

const record = (entry) => fs.appendFileSync(process.env.INIT_EVENTS, `${JSON.stringify(entry)}\n`);
const timeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (milliseconds) => {
  assert.equal(milliseconds, 25000);
  record({ event: 'api_budget', milliseconds });
  return timeout(1000);
};
const schedule = global.setTimeout;
global.setTimeout = (callback, milliseconds, ...args) => {
  if (milliseconds === 180000) record({ event: 'command_budget', milliseconds });
  return schedule(callback, milliseconds === 180000 ? 1000 : milliseconds, ...args);
};

host.prepare = async (root, evidence) => {
  record({ event: 'root', root });
  const env = isolatedEnvironment(root);
  Object.assign(env, { INIT_EVENTS: process.env.INIT_EVENTS, INIT_MODE: process.env.INIT_MODE,
    INIT_MARKER: path.join(root, 'configured') });
  const script = path.join(__dirname, 'initialization-host.cjs');
  for (const entry of ['serve', 'debug']) fs.writeFileSync(path.join(root, entry), `require(${JSON.stringify(script)});\n`);
  const config = path.join(root, 'opencode.json');
  fs.writeFileSync(config, JSON.stringify({ skills: { paths: [root] } }));
  evidence.host = {};
  const active = new Set();
  const command = runner(env, evidence, active, root);
  return { env, config, host: process.execPath, directories: { outside: root }, packaged: { command },
    async cleanup() {
      for (const child of active) terminate(child);
      assert.equal(active.size, 0);
      return { active_children: active.size };
    } };
};
