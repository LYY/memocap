const { PassThrough, Writable, Readable } = require('node:stream');
const endpoint = 'https://sub2api.big.zone/v1/responses';
function selection() {
  return { kind: 'parent-node-selected-address-v1', endpoint, hostname: 'sub2api.big.zone',
    address: '198.18.5.40', family: 4, port: 443, selection: { id: 'synthetic-selection',
      approval_id: 'offline-selection-only', selected_at: new Date().toISOString(),
      resolution_sha256: 'a'.repeat(64), route_sha256: 'b'.repeat(64), route_interface: 'utun4' } };
}
function memoryHTTP(handler, change = (options) => options) {
  return (supplied, receive) => {
    const options = change(supplied);
    const incoming = new PassThrough();
    Object.assign(incoming, { method: options.method, url: options.path, headers: options.headers });
    const response = new PassThrough({ highWaterMark: 16384 });
    response.on('error', () => {}); incoming.on('error', () => {});
    response.writeHead = (status, headers) => {
      response.statusCode = status; response.headers = headers; response.headersSent = true; receive(response);
    };
    const request = new Writable({ autoDestroy: false,
      write(chunk, encoding, done) { incoming.write(chunk, encoding, done); },
      final(done) { incoming.end(); done(); },
      destroy(error, done) { incoming.emit('aborted'); incoming.destroy(error); response.destroy(error); done(error); } });
    request.setTimeout = () => request;
    response.once('error', (error) => request.destroy(error));
    void handler(incoming, response); return request;
  };
}
function upstream(options = {}) {
  const calls = []; const started = Promise.withResolvers(); let latest; let reply;
  const send = (url, init, receive) => {
    const chunks = [];
    const request = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
    request.on('error', () => {});
    latest = request; calls.push({ url, init, chunks }); started.resolve();
    reply = () => {
      const response = options.body ?? Readable.from([Buffer.from('data: ok\n\n')]);
      response.statusCode = options.status ?? 200;
      response.headers = options.headers ?? { 'content-type': 'text/event-stream' };
      response.on('error', () => {}); receive(response); return response;
    };
    if (!options.late) request.once('finish', () => {
      if (options.error) request.destroy(options.error); else reply();
    });
    return request;
  };
  return { send, calls, started: started.promise, request: () => latest, reply: () => reply() };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
module.exports = { selection, endpoint, memoryHTTP, upstream, tick };
