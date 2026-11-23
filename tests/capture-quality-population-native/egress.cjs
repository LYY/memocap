const { requireStage, identifier } = require('./value.cjs');
const { meteredBody, requestBody, dispatch } = require('./provider-transport.cjs');
const correlation = 'x-memocap-population-session';
function egress({ origin, endpoints, charge, session, cleanupSession = session, transport, providerTransport = transport }) {
  let stopped;
  const terminal = new AbortController();
  const stop = (code) => { stopped ??= code; terminal.abort(); return stopped; };
  async function send(input, init, provider = false) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!provider && url.origin === origin) {
      if (stopped) {
        const path = /^\/session\/((?:[a-zA-Z0-9_.-]|%3A){1,160})(\/abort)?$/.exec(url.pathname);
        const id = path && decodeURIComponent(path[1]);
        requireStage(path && identifier(id) && encodeURIComponent(id) === path[1] && cleanupSession(id) &&
          request.method === (path[2] ? 'POST' : 'DELETE') && !url.search && !url.hash && !request.body, stopped);
      }
      return transport(new Request(request, { redirect: 'manual' }));
    }
    requireStage(!stopped, stopped);
    requireStage(provider && endpoints.includes(request.url), 'unexpected_destination');
    const owner = request.headers.get(correlation);
    requireStage(session(owner), 'provider_session_unobserved');
    request.headers.delete(correlation);
    const signal = AbortSignal.any([request.signal, terminal.signal, AbortSignal.timeout(30000)]);
    try {
      const body = await requestBody(request.body, { charge, signal, stop });
      requireStage(!stopped, stopped);
      signal.throwIfAborted();
      charge('provider_requests');
      const response = await dispatch(providerTransport, new Request(request, { body, redirect: 'manual', signal }));
      if (response.status >= 300 && response.status < 400 || [401, 403].includes(response.status)) {
        stop([401, 403].includes(response.status) ? 'permission_denied' : 'unexpected_redirect');
        if (response.body) void response.body.cancel(stopped).catch(() => stop('provider_cancel_unknown'));
        requireStage(false, stopped);
      }
      return new Response(meteredBody(response.body, { charge, signal, stop, direction: 'response' }), {
        status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { stop(error?.code && error.name === 'TransportBlocked' ? error.code :
      signal.aborted ? 'provider_aborted' : 'provider_dispatch_unknown'); throw error; }
  }
  return { global: (input, init) => send(input, init), provider: (input, init) => send(input, init, true), correlation };
}
module.exports = { egress, correlation };
