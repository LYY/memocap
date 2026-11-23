const { CanaryBlocked } = require('./entry.cjs');

const correlation = 'x-memocap-native-session';

function nativeFetch({ budget, providerDestinations, authDestinations, transport, controlOrigin }) {
  async function send(input, init = {}, providerSeam = false) {
    const request = new Request(input, init);
    const destination = request.url;
    if (controlOrigin && new URL(destination).origin === controlOrigin) return transport(input, init);
    const provider = providerDestinations.includes(destination);
    const auth = authDestinations.includes(destination);
    if (!provider && !auth) { budget.stop('unexpected_destination'); throw new CanaryBlocked('unexpected_destination'); }
    const session = request.headers.get(correlation);
    if (provider && !providerSeam) {
      budget.stop('provider_hook_bypassed'); throw new CanaryBlocked('provider_hook_bypassed');
    }
    const attempt = budget.dispatch(session, provider ? 'provider' : 'auth');
    request.headers.delete(correlation);
    const state = budget.snapshot();
    const review = state.reviews[attempt.review];
    const remaining = Math.min(300000 - (Date.now() - state.began),
      review ? 30000 - (Date.now() - review.began) : 300000);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, remaining))]);
    let response;
    try { response = await transport(new Request(request, { redirect: 'manual', signal })); }
    catch {
      budget.stop('dispatch_uncertain'); throw new CanaryBlocked('dispatch_uncertain');
    }
    budget.event({ kind: 'provider.response', ordinal: attempt.ordinal, status: response.status,
      content_type: ['application/json', 'text/event-stream'].includes(response.headers.get('content-type')?.split(';')[0])
        ? response.headers.get('content-type').split(';')[0] : 'unknown' });
    if (response.status >= 300 && response.status < 400) {
      budget.stop('unexpected_destination'); throw new CanaryBlocked('unexpected_destination');
    }
    if (response.status === 401 || response.status === 403) {
      budget.stop('permission_denied'); throw new CanaryBlocked('permission_denied');
    }
    return response;
  }
  return { global: (input, init) => send(input, init, false), provider: (input, init) => send(input, init, true) };
}

module.exports = { nativeFetch, correlation };
