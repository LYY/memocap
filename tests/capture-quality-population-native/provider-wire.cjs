const http = require('node:http');
const { Readable } = require('node:stream');
const { requireStage, hash, TransportBlocked } = require('./value.cjs');
const { requestBody } = require('./provider-transport.cjs');
function providerHeaders(headers) {
  const accepted = {};
  for (const [name, content] of new Headers(headers)) {
    requireStage(!['host', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'upgrade',
      'trailer', 'te'].includes(name) && !name.startsWith('x-memocap-'), 'provider_header_forbidden');
    requireStage(!['content-encoding', 'accept-encoding'].includes(name) || content === 'identity', 'provider_request_encoding');
    if (name !== 'content-length') accepted[name] = content;
  }
  requireStage(Buffer.byteLength(JSON.stringify(accepted)) <= 8192, 'provider_header_budget');
  return accepted;
}
function providerWire(options, send = http.request) {
  const binding = structuredClone(options.binding);
  return async (request) => {
    requireStage(request.url === binding.endpoint && request.method === 'POST', 'unexpected_destination');
    const headers = providerHeaders(request.headers);
    const body = await requestBody(request.body, { charge() {}, signal: request.signal, stop: (code) => code });
    request.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let incoming; let finished = false; let outgoing;
      const cleanup = () => request.signal.removeEventListener('abort', abort);
      const fail = (error) => {
        if (finished) return;
        finished = true; outgoing?.destroy(error); incoming?.destroy(error); cleanup(); reject(error);
      };
      const abort = () => fail(new TransportBlocked('provider_aborted'));
      try {
        outgoing = send({ socketPath: options.socket, path: '/provider', method: 'POST', agent: false,
          headers: { authorization: `Bearer ${options.token}`, 'content-length': body?.byteLength ?? 0, 'accept-encoding': 'identity',
            'x-memocap-selection': hash(binding), 'x-memocap-root': options.root(),
            'x-memocap-provider-headers': JSON.stringify(headers) } }, (response) => {
          if (finished || request.signal.aborted) { response.destroy(); return; }
          incoming = response;
          response.on('error', () => fail(new TransportBlocked('provider_control_unknown')));
          response.once('end', () => { finished = true; cleanup(); });
          try {
            requireStage(response.statusCode === 200 && response.headers['x-memocap-provider'] === 'stream', 'provider_control_failed');
            requireStage(!response.headers['content-encoding'] || response.headers['content-encoding'] === 'identity', 'provider_response_encoding');
            const status = Number(response.headers['x-memocap-provider-status']);
            requireStage(Number.isInteger(status) && status >= 200 && status <= 599, 'provider_control_failed');
            resolve(new Response(Readable.toWeb(response, { strategy: { highWaterMark: 0 } }), {
              status, headers: { 'content-type': response.headers['content-type'],
                ...(response.headers['x-memocap-dispatch-id'] ? { 'x-memocap-dispatch-id': response.headers['x-memocap-dispatch-id'] } : {}) } }));
          } catch (error) { fail(error); }
        });
        outgoing.on('error', () => fail(new TransportBlocked('provider_control_unknown')));
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort(); else outgoing.end(body);
      } catch (error) { fail(error instanceof TransportBlocked ? error : new TransportBlocked('provider_control_unknown')); }
    });
  };
}
module.exports = { providerWire, providerHeaders };
