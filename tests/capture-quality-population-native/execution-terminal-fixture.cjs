const { install } = require('./plugin-runtime.cjs');
const { fakeHost } = require('./fake-host.cjs');
const { requireStage } = require('./value.cjs');

async function terminalFixture(captureExecutionMs, emit = true, maintenanceExecutionMs) {
  const commands = []; const replies = []; const ready = [];
  const waiting = Promise.withResolvers(); let seam; let packet; let boundary;
  const hooks = await install({ client: { session: {} }, serverUrl: new URL('http://inert.invalid') }, {
    kind: 'quality-full-population-plugin-v1', source_sha256: require('./authorization.cjs').sources().digest,
    approval_id: 'injected-only', socket: '/synthetic/socket', token: 'injected-only', privateRoot: '/synthetic',
    paths: { database: '/synthetic/db' }, endpoints: [], case: 'same-task-third-turn', captureExecutionMs, maintenanceExecutionMs,
  }, { fetch: async () => { throw new Error('network_forbidden'); },
    native: { invoke: async () => { throw new Error('native_forbidden'); } },
    fixture: async (_, injected) => { seam = injected; return { bind(value) { packet = value; }, state: () => ({ children: [] }), dispose() {} }; },
    rpc: async (route, value) => {
      switch (route) {
        case '/ready': ready.push(value); return {};
        case '/next': { const command = commands.shift() ?? { method: 'stop' }; if (command.method === 'wait') waiting.resolve(); return command; }
        case '/result': replies.push(value); return {};
        case '/observations': for (const event of value.events) boundary?.record(event); return {};
        default: return {};
      }
    } });
  const call = async (method, value) => {
    commands.push({ id: replies.length, method, value }); await hooks.qualityPump();
    const result = replies.at(-1); requireStage(!result.error, result.error); return result.value;
  };
  const host = fakeHost(); const deliver = host.deliver;
  host.deliver = async (value, target) => {
    boundary = target; await call('bind', { ...value, root: 'root', review: true, captureExecutionMs, maintenanceExecutionMs }); await deliver(value, target);
  };
  host.settle = async (request) => {
    const emitReview = () => seam.review({ parentID: packet.root, user_id: request.user, workflow: 'capture',
      status: 'failed', reason: 'capture_timeout', execution_profile: require('../../plugin/capture/execution-profile.js').captureExecutionProfile(captureExecutionMs, maintenanceExecutionMs) });
    if (host.packets.length === 1) { if (emit) setTimeout(emitReview, captureExecutionMs + 318); }
    else emitReview();
    return call('wait', request);
  };
  return { host, waiting: waiting.promise, ready, call, emit: (event) => seam.review(event), dispose: () => hooks.dispose() };
}
module.exports = { terminalFixture };
