const { randomUUID } = require('node:crypto');
const { writeReceipt, receipt } = require('../capture-quality-native/projection.cjs');
const { validateReceipt } = require('../../plugin/protocol.js');
const { requireStage, hash } = require('./value.cjs');

function observeNativeInvoke(invoke, port) {
  requireStage(typeof invoke === 'function' && typeof port.binding === 'function' && typeof port.record === 'function', 'native_observer_required');
  const writes = new Map();
  return async (argv, options) => {
    requireStage(!(argv[0] === 'organize' && argv[1] === 'apply'), 'quality_organization_apply_forbidden');
    const binding = port.binding(argv, options);
    requireStage(binding, 'native_caller_unobserved');
    port.charge('native_calls');
    port.charge('native_processes', 2);
    const write = argv[0] === 'remember' || argv[0] === 'organize' && argv[1] === 'maintain';
    const independentRead = argv[0] === 'read' || argv[0] === 'organize' && argv[1] === 'read';
    if (independentRead || argv[0] === 'recall') port.charge('native_reads');
    const key = `${binding.session}/${binding.message}`;
    let attempt;
    const emit = (kind, details) => port.record({ kind, root: binding.root, user: binding.user, workflow: binding.workflow, ...details });
    const response = await invoke(argv, write ? { ...options, beforeSpawn(...args) {
      requireStage(typeof options.beforeSpawn === 'function', 'production_dispatch_barrier_missing');
      options.beforeSpawn(...args);
      attempt = randomUUID();
      const request = argv[0] === 'organize' ? JSON.parse(options.stdin) : null;
      emit('consume', { surface: request ? 'production-maintenance-beforeSpawn-returned' : 'production-capture-beforeSpawn-returned',
        workflow: request ? 'maintenance' : 'capture', ...(request ? { request_hash: hash(request) } : {}),
        session: binding.session, message: binding.message });
      emit('native.dispatch', { attempt, workflow: binding.workflow ?? (argv[0] === 'remember' ? 'capture' : 'maintenance'),
        session: binding.session, message: binding.message, tool: binding.tool,
        permission: 'resolved', request, database: port.database(), surface: 'actual-native-invoke-boundary' });
      writes.set(key, { attempt });
    } } : options);
    if (write) {
      requireStage(attempt, 'native_dispatch_unobserved');
      const projected = writeReceipt(response.receipt, { command: argv[0], caller: {
        actor: 'plugin', session_id: binding.session, message_id: binding.message } });
      emit('native.commit', { attempt, receipt: projected, ...(response.receipt.organization ? { post: response.receipt.organization } : {}) });
    } else if (independentRead && writes.has(key)) {
      validateReceipt(response.receipt);
      emit('native.readback', { attempt: writes.get(key).attempt, receipt: receipt(response.receipt),
        ...(response.receipt.organization ? { organization: response.receipt.organization } : {}) });
    }
    return response;
  };
}
module.exports = { observeNativeInvoke };
