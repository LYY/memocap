const fs = require('node:fs');
const { spawn } = require('node:child_process');
async function main() {
  const options = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const argv = process.argv.slice(3);
  const report = async (value) => {
    const response = await fetch(options.control, { method: 'POST', body: JSON.stringify(value), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`native telemetry ${response.status}`);
  };
  if (argv[0] === '--version' && fs.existsSync(options.marker)) {
    fs.unlinkSync(options.marker);
    const response = await fetch(`${options.control}/gate?id=handshake`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('native version gate failed');
  }
  if (argv[0] === 'remember') await report({ phase: 'native.write.spawn' });
  const settings = ['remember', 'read'].includes(argv[0]) ? await (await fetch(options.control)).json() : {};
  const changeRead = argv[0] === 'read' && (settings.failRead || settings.mismatchReadTags);
  const child = spawn(options.native, argv, { stdio: settings.unknownWrite || changeRead ? ['inherit', 'pipe', 'inherit'] : 'inherit', env: process.env });
  const chunks = [];
  child.stdout?.on('data', (chunk) => { if (changeRead) chunks.push(chunk); });
  child.once('error', (error) => { process.stderr.write(error.message); process.exitCode = 1; });
  child.once('close', async (code) => {
    if (changeRead && code === 0) {
      await report({ phase: 'native.read.controlled', mode: settings.failRead ? 'failure' : 'tag_mismatch' });
      if (settings.failRead) { process.exitCode = 1; return; }
      const receipt = JSON.parse(Buffer.concat(chunks).toString());
      for (const entry of receipt.results) entry.memory.tags = 'controlled-tag-mismatch';
      process.stdout.write(JSON.stringify(receipt));
    }
    if (argv[0] === 'remember' && code === 0) {
      await report({ phase: 'native.write.committed' });
      if (settings.afterWriteGate) await fetch(`${options.control}/gate?id=after-write`, { signal: AbortSignal.timeout(20000) });
      if (settings.unknownWrite) process.stdout.write('synthetic lost receipt\n');
    }
    if (argv[0] === 'activity' && argv[1] === 'record') {
      const payload = JSON.parse(argv[argv.indexOf('--payload') + 1]);
      if (payload.detail.phase === 'capture_review') await report({ phase: 'capture.review', payload, exit_code: code });
    }
    process.exitCode = code ?? 1;
  });
}
main().catch((error) => { process.stderr.write(error.stack); process.exitCode = 1; });
