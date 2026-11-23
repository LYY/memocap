const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { egress, correlation } = require('./egress.cjs');
const { pinnedFetch } = require('./selected-address.cjs');
const { providerHeaders } = require('./provider-wire.cjs');
const { requireStage, hash, TransportBlocked } = require('./value.cjs');
function providerBridge(options, charge) {
  const binding = structuredClone(options.binding); const used = {}; const active = new Set();
  let terminal;
  const transport = egress({ origin: 'http://127.0.0.1', endpoints: [binding.endpoint], session: options.session,
    transport: pinnedFetch(binding, options.send, options.observation), charge(key, amount = 1) {
      requireStage((used[key] ?? 0) + amount <= options.limits[key], `case_budget_${key}`);
      if (key.endsWith('_bytes')) charge('control_bytes', amount);
      charge(key, amount); used[key] = (used[key] ?? 0) + amount;
    } });
  const stop = (reason) => { terminal ??= reason; for (const controller of active) controller.abort(); };
  return { stop, async forward(request, response) {
    requireStage(!terminal, terminal);
    const controller = new AbortController(); active.add(controller);
    const abort = () => { if (!response.writableFinished) controller.abort(); };
    request.once('aborted', abort); response.once('close', abort);
    try {
      requireStage(!request.headers['content-encoding'] || request.headers['content-encoding'] === 'identity', 'provider_request_encoding');
      requireStage(request.headers['x-memocap-selection'] === hash(binding), 'selected_provider_binding');
      requireStage(options.session(request.headers['x-memocap-root']), 'provider_session_unobserved');
      const encoded = request.headers['x-memocap-provider-headers'];
      requireStage(typeof encoded === 'string' && Buffer.byteLength(encoded) <= 8192, 'provider_header_budget');
      const headers = providerHeaders(JSON.parse(encoded));
      headers[correlation] = request.headers['x-memocap-root'];
      const result = await transport.provider(new Request(binding.endpoint, { method: 'POST', headers,
        body: Readable.toWeb(request, { strategy: { highWaterMark: 0 } }), duplex: 'half', signal: controller.signal }));
      response.writeHead(200, { 'x-memocap-provider': 'stream', 'x-memocap-provider-status': String(result.status),
        'x-memocap-dispatch-id': result.headers.get('x-memocap-dispatch-id'),
        'content-type': result.headers.get('content-type') });
      await pipeline(Readable.fromWeb(result.body), response, { signal: controller.signal });
    } catch (error) {
      stop(error instanceof TransportBlocked ? error.code : 'provider_bridge_unknown');
      response.destroy(new TransportBlocked(terminal));
    } finally {
      active.delete(controller); request.removeListener('aborted', abort); response.removeListener('close', abort);
    }
  } };
}
module.exports = { providerBridge };
