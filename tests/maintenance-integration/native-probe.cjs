const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const settings = JSON.parse(fs.readFileSync(process.env.MAINTENANCE_PROBE_SETTINGS, 'utf8'));
const args = process.argv.slice(2);
const request = (url, body) => new Promise((resolve, reject) => {
  const call = http.request(url, { method: body ? 'POST' : 'GET' }, (response) => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { text += chunk; });
    response.on('end', () => resolve(text));
  });
  call.on('error', reject);
  call.end(body && JSON.stringify(body));
});
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', async () => {
  const mode = JSON.parse(await request(settings.control));
  if (args.includes('--version') && mode.handshakeGate) await request(`${settings.control}/gate?id=handshake`);
  const maintain = args[0] === 'organize' && args[1] === 'maintain';
  if (maintain && mode.nativeMode === 'before') await request(`${settings.control}/gate?id=native-before`);
  const child = spawn(settings.native, args, { env: { ...process.env, MEMOCAP_BINARY: settings.native }, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let output = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.pipe(process.stderr);
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const acknowledged = request(settings.control, { phase: 'native.spawn', args, stdin }).then(() => {
    if (child.stdin) child.stdin.end(stdin);
  });
  const [[code, signal]] = await Promise.all([closed, acknowledged]);
  await request(settings.control, { phase: 'native.finished', args, code, signal, stderr,
    ...(args.length === 1 && args[0] === '--version' ? { stdout: output } : {}),
  });
  if (maintain) await request(settings.control, { phase: 'native.completed', code, receipt: JSON.parse(output) });
  if (maintain && mode.nativeMode === 'after') await request(`${settings.control}/gate?id=native-after`);
  if (!maintain || mode.nativeMode !== 'lost') process.stdout.write(output);
  process.exitCode = code;
});
if (args.includes('--version') || !args.includes('read') && !args.includes('maintain') && !args.includes('apply')) process.stdin.resume();
