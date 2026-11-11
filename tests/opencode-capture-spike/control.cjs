const http = require('node:http');
const { EventEmitter, once } = require('node:events');

async function controlServer() {
  const events = [];
  const bus = new EventEmitter();
  const settings = { tools: [] };
  const gates = new Map();
  const observe = (event) => {
    events.push(event);
    bus.emit('observed', event);
  };
  const server = http.createServer(async (request, response) => {
    if (request.url.startsWith('/gate?')) {
      const sessionID = new URL(request.url, 'http://localhost').searchParams.get('id');
      gates.set(sessionID, response);
      observe({ phase: 'gate.waiting', sessionID });
      return;
    }
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(settings));
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const event = JSON.parse(raw);
    observe(event);
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    events, settings, url: `http://127.0.0.1:${server.address().port}`,
    release(sessionID) {
      const response = gates.get(sessionID);
      if (!response) throw new Error(`worker gate not pending: ${sessionID}`);
      response.end('{}');
      gates.delete(sessionID);
    },
    releaseAll() {
      for (const response of gates.values()) response.end('{}');
      gates.clear();
    },
    async wait(predicate) {
      const found = events.find(predicate);
      if (found) return found;
      const signal = AbortSignal.timeout(20000);
      while (true) {
        const [event] = await once(bus, 'observed', { signal });
        if (predicate(event)) return event;
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { controlServer };
