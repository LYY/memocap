const { correlation } = require('./egress.cjs');
const { requireStage } = require('./value.cjs');
function responseMeter(record, ownerOf) {
  const pending = new Map(); const completed = new Set();
  const key = (owner, session) => JSON.stringify([owner.root, owner.user, session]);
  async function forward(request, owner, send) {
    const session = request.headers.get(correlation); const identity = key(owner, session);
    if (!pending.has(identity)) pending.set(identity, []);
    const attempt = { dispatch_id: null }; pending.get(identity).push(attempt);
    const response = await send(request);
    attempt.dispatch_id = response.headers.get('x-memocap-dispatch-id');
    if (attempt.dispatch_id) record('provider.link', { dispatch_id: attempt.dispatch_id, session }, owner);
    return response;
  }
  return {
    reset() { pending.clear(); completed.clear(); },
    forward,
    observedProvider(input, init, send) {
      const request = new Request(input, init); const owner = ownerOf(request.headers.get(correlation));
      requireStage(owner?.user, 'provider_session_unobserved');
      return forward(request, owner, send);
    },
    take(owner, session) {
      pending.delete(key(owner, session));
      return { dispatch_id: null };
    },
    parent(owner, info) {
      const identity = key(owner, info.sessionID);
      if (!info.time?.completed || completed.has(info.id) || !pending.has(identity)) return null;
      completed.add(info.id); return this.take(owner, info.sessionID);
    }
  };
}
module.exports = { responseMeter };
