const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const record = (event) => fs.appendFileSync(process.env.INIT_EVENTS,
  `${JSON.stringify({ event, pid: process.pid, at: Date.now() })}\n`);
const mode = process.env.INIT_MODE;
if (path.basename(process.argv[1]) === 'debug') {
  record('config_enter');
  console.error('fixture config stderr');
  if (mode === 'config_exit') process.exit(23);
  if (mode === 'config_timeout') setInterval(() => {}, 1000);
  else {
    const config = JSON.parse(fs.readFileSync('opencode.json'));
    require('node:assert/strict').equal(config.model, 'wire/wire-model');
    fs.writeFileSync(process.env.INIT_MARKER, 'completed');
    record('config_finish');
    console.log(JSON.stringify(config));
  }
} else {
  const port = Number(process.argv.find((arg) => arg.startsWith('--port=')).split('=')[1]);
  const server = http.createServer((request, response) => {
    record(request.url);
    if (request.url === '/instance/dispose') { response.writeHead(503); response.end('dispose sentinel'); return; }
    if (!fs.existsSync(process.env.INIT_MARKER)) { record('http_before_config'); return; }
    if (request.url === '/command') {
      if (mode === 'http_hang') return;
      if (mode === 'body_hang') { response.writeHead(200); response.flushHeaders(); return; }
      response.end(JSON.stringify([{ name: 'memory', description: 'fixture', source: 'fixture' }]));
    } else { response.writeHead(503); response.end('CONTROLLED_NEXT_ENDPOINT'); }
  });
  server.listen(port, '127.0.0.1', () => {
    record('listener_ready');
    console.error('fixture serve stderr');
    console.log(`opencode server listening on http://127.0.0.1:${port}`);
  });
}
