const https = require('node:https');
const { Readable } = require('node:stream');
const { requireStage, TransportBlocked } = require('./value.cjs');
const { requestBody, providerBodyLimit } = require('./provider-transport.cjs');
const { responsesTerminal } = require('./responses-terminal.cjs');
const { randomUUID } = require('node:crypto');
function pinnedFetch(binding, send = https.request, observation) {
  const selected = structuredClone(binding);
  return async (request) => {
    requireStage(request.url === selected.endpoint && request.method === 'POST', 'unexpected_destination');
    request.signal.throwIfAborted();
    const body = await requestBody(request.body, { charge() {}, signal: request.signal, stop: (code) => code });
    const bytes = body ?? Buffer.alloc(0);
    request.signal.throwIfAborted();
    let record;
    try { record = observation?.(); } catch { throw new TransportBlocked('provider_observation_failed'); }
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1, proxyEnv: {} });
    const dispatch_id = randomUUID();
    const identity = { dispatch_id, clock_domain: `node.performance:${performance.timeOrigin}` };
    return new Promise((resolve, reject) => {
      let outgoing; let incoming; let finished = false; let bodyController;
      const emit = (event) => {
        try { record?.(event); } catch { throw new TransportBlocked('provider_observation_failed'); }
      };
      const cleanup = () => { request.signal.removeEventListener('abort', abort); agent.destroy(); };
      const fail = (error) => {
        if (finished) return;
        finished = true; let failure = error;
        try { emit({ ...identity, kind: 'provider.finished', monotonic_ms: performance.now(), outcome: 'failed', reason: error.code ?? 'provider_dispatch_unknown' }); }
        catch (observationError) { failure = observationError; }
        finally { bodyController?.error(failure); outgoing?.destroy(failure); incoming?.destroy(failure); cleanup(); reject(failure); }
      };
      const abort = () => fail(new TransportBlocked('provider_aborted'));
      try {
        const started = performance.now();
        try { outgoing = send(new URL(selected.endpoint), { hostname: selected.hostname, method: 'POST',
          headers: { ...Object.fromEntries(request.headers), host: selected.hostname,
            'accept-encoding': 'identity', 'content-length': bytes.length },
          agent, family: 4, autoSelectFamily: false, servername: selected.hostname, rejectUnauthorized: true,
          lookup(hostname, options, callback) {
            if (hostname !== selected.hostname) { callback(new TransportBlocked('unexpected_destination')); return; }
            if (options.all) callback(null, [{ address: selected.address, family: 4 }]);
            else callback(null, selected.address, 4);
          } }, (response) => {
          if (finished || request.signal.aborted) { response.destroy(); return; }
          incoming = response;
          response.on('error', () => fail(new TransportBlocked('provider_response_unknown')));
          try {
            requireStage(!response.headers['content-encoding'] || response.headers['content-encoding'] === 'identity', 'provider_response_encoding');
            const reader = Readable.toWeb(response, { strategy: { highWaterMark: 0 } }).getReader();
            const terminal = responsesTerminal(response.headers['content-type']); let consumed = 0;
            const stream = new ReadableStream({
              start(controller) { bodyController = controller; },
              async pull(controller) {
                try {
                  const next = await reader.read(); if (finished) return;
                  if (next.done) {
                    emit({ ...identity, kind: 'provider.finished', monotonic_ms: performance.now(), outcome: 'response',
                      status: response.statusCode, terminal: terminal.finish() });
                    finished = true; cleanup(); reader.releaseLock(); controller.close(); return;
                  }
                  requireStage(consumed + next.value.byteLength <= providerBodyLimit, 'provider_response_body_limit');
                  consumed += next.value.byteLength; terminal.push(next.value); controller.enqueue(next.value);
                } catch (error) { fail(error instanceof TransportBlocked ? error : new TransportBlocked('provider_response_unknown')); }
              },
              cancel() { fail(new TransportBlocked('provider_response_cancelled')); },
            }, { highWaterMark: 0 });
            resolve(new Response(stream, { status: response.statusCode,
              headers: { 'content-type': response.headers['content-type'] ?? 'application/octet-stream', 'x-memocap-dispatch-id': dispatch_id } }));
          } catch (error) { fail(error instanceof TransportBlocked ? error : new TransportBlocked('provider_response_unknown')); }
        }); } finally {
          outgoing?.on('error', () => fail(new TransportBlocked('provider_dispatch_unknown')));
          emit({ ...identity, kind: 'provider.dispatch', monotonic_ms: started });
        }
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort(); else outgoing.end(bytes);
      } catch (error) { fail(error instanceof TransportBlocked ? error : new TransportBlocked('provider_dispatch_unknown')); }
    });
  };
}
module.exports = { pinnedFetch };
