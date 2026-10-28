function enter(evidence, name) {
  const phase = { started_at: new Date().toISOString(), started_monotonic_ms: performance.now() };
  evidence.phases ||= {};
  evidence.phases[name] = phase;
  return phase;
}

function finish(phase, error) {
  phase.finished_at = new Date().toISOString();
  phase.finished_monotonic_ms = performance.now();
  phase.elapsed_ms = phase.finished_monotonic_ms - phase.started_monotonic_ms;
  phase.status = error ? 'failed' : 'completed';
  if (error) phase.error = { name: error.name, message: error.message };
}

async function observe(evidence, name, action) {
  const phase = enter(evidence, name);
  try { const result = await action(); finish(phase); return result; }
  catch (error) { finish(phase, error); throw error; }
}

function retain(filename, evidence, roots) {
  const fs = require('node:fs');
  let text = JSON.stringify(evidence, null, 2);
  for (const [root, label] of roots) text = text.split(root).join(label);
  fs.mkdirSync(require('node:path').dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${text}\n`);
  require('node:assert/strict').equal(JSON.parse(fs.readFileSync(filename)).status, evidence.status);
}

function recordCleanupFailure(evidence, failure, error) {
  if (!failure) {
    evidence.status = 'failed';
    evidence.blocker = { message: error.message, stack: error.stack };
  }
  return failure || error;
}

module.exports = { enter, finish, observe, retain, recordCleanupFailure };
