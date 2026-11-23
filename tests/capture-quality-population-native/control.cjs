const http = require('node:http');
const { requireStage, size, hash, TransportBlocked } = require('./value.cjs');
const { providerBridge } = require('./provider-bridge.cjs');
const maximum = 262144;
const { executionProfile, captureCollectionWindow } = require('./execution-profile.cjs');

function wire(socketPath, token, send = http.request, captureExecutionMs, maintenanceExecutionMs) {
  const ceiling = captureCollectionWindow(executionProfile(undefined, captureExecutionMs, maintenanceExecutionMs), true).outer_ms;
  return (route, body = {}) => new Promise((resolve, reject) => {
    const bytes = JSON.stringify(body);
    requireStage(size(body) <= maximum, 'control_request_budget');
    const request = send({ socketPath, path: route, method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) } }, async (response) => {
      try {
        const chunks = []; let length = 0;
        for await (const chunk of response) {
          length += chunk.length; requireStage(length <= maximum, 'control_response_budget'); chunks.push(chunk);
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requireStage(response.statusCode === 200 && !result.error, result.error ?? 'control_failed');
        resolve(result);
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
    request.setTimeout(ceiling, () => request.destroy(new TransportBlocked('control_deadline')));
    request.end(bytes);
  });
}

function control(token) {
  const ready = Promise.withResolvers();
  const queue = [];
  const pending = new Map();
  let receiver; let ordinal = 0; let calls = 0; let boundary; let terminal; let prepared; let materialize; let provider; let observed;
  function dispatch() { if (receiver && queue.length) { const value = receiver; receiver = null; value(queue.shift()); } }
  function bill(charges = {}) {
    requireStage(!provider || !Object.keys(charges).some((key) => key.startsWith('provider_')), 'provider_charge_custody');
    for (const [key, amount] of Object.entries(charges)) boundary?.charge(key, amount);
  }
  async function route(url, body) {
    if (url === '/ready') { ready.resolve(body); return {}; }
    if (url === '/next') { requireStage(!receiver, 'control_duplicate_wait'); return new Promise((resolve) => { receiver = resolve; dispatch(); }); }
    if (url === '/observations') {
      requireStage(boundary, 'control_boundary_unbound');
      bill(body.charges);
      for (const event of body.events ?? []) boundary.record(event);
      return {};
    }
    if (url === '/result') {
      const waiter = pending.get(body.id); requireStage(waiter, 'control_unknown_result'); pending.delete(body.id);
      try {
        bill(body.charges);
        for (const event of body.events ?? []) boundary?.record(event);
        if (body.error) waiter.reject(new TransportBlocked(body.error)); else waiter.resolve(body.value);
      } catch (error) { waiter.reject(error); }
      return {};
    }
    if (url === '/boundary') {
      requireStage(boundary && ['user', 'prepare', 'tool', 'complete'].includes(body.method), 'control_boundary_method');
      if (body.method === 'prepare' && body.value?.materialize) {
        requireStage(prepared && hash(prepared) === hash(body.value.materialize) && materialize, 'unprepared_carrier_materialization');
        const value = prepared; prepared = null; await materialize(value); return {};
      }
      const value = await boundary[body.method](body.value);
      if (body.method === 'user') observed = { root: body.value.message.sessionID, user: body.value.message.id };
      if (body.method === 'prepare') { requireStage(!prepared, 'carrier_prepare_replayed'); prepared = value; }
      return { value };
    }
    throw new TransportBlocked('control_unknown_route');
  }
  async function handler(request, response) {
    try {
      requireStage(request.method === 'POST' && request.headers.authorization === `Bearer ${token}`, 'control_auth');
      requireStage(!terminal && ++calls <= 256, terminal ?? 'control_call_budget');
      if (request.url === '/provider') {
        requireStage(provider && boundary?.charge, 'selected_provider_binding');
        boundary.charge('control_requests');
        await provider.forward(request, response); return;
      }
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; requireStage(bytes <= maximum, 'control_request_budget'); chunks.push(chunk); }
      boundary?.charge?.('control_requests'); boundary?.charge?.('control_bytes', bytes);
      const result = await route(request.url, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      requireStage(size(result) <= maximum, 'control_response_budget');
      boundary?.charge?.('control_bytes', size(result));
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
    } catch (error) {
      if (request.url === '/provider') { response.destroy(new TransportBlocked(error instanceof TransportBlocked ? error.code : 'control_failed')); return; }
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof TransportBlocked ? error.code : 'control_failed' }));
    }
  }
  function call(method, value) {
    requireStage(!terminal && pending.size < 2, terminal ?? 'control_pending_budget');
    const waiter = Promise.withResolvers(); const id = ++ordinal;
    pending.set(id, waiter); queue.push({ id, method, value }); dispatch();
    return waiter.promise;
  }
    return { handler, ready: ready.promise, call, bind(value, writer) { boundary = value; materialize = writer; observed = undefined; },
    bindProvider(options) { requireStage(!provider, 'provider_binding_replayed');
      provider = providerBridge({ ...options, observation() {
        const target = boundary; const owner = structuredClone(observed);
        return (event) => target.record?.({ ...event, ...owner, workflow: null });
      } }, (...args) => boundary.charge(...args)); },
    stop(reason = 'control_closed') {
      provider?.stop(reason);
      terminal = reason; receiver?.({ method: 'stop' }); receiver = null;
      for (const waiter of pending.values()) waiter.reject(new TransportBlocked(reason)); pending.clear();
    } };
}
module.exports = { wire, control };
