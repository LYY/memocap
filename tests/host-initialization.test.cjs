const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { isolatedEnvironment } = require('./packaged-runtime.cjs');
const { portClosed } = require('./opencode-v1/host.cjs');

function orchestration(context, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memocap-init-regression-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventsFile = path.join(root, 'events.jsonl');
  const evidenceFile = path.join(root, 'evidence.json');
  const child = spawnSync(process.execPath, ['--require', path.join(__dirname, 'opencode-v1/initialization-fixture.cjs'),
    '--test', path.join(__dirname, 'opencode-v1.integration.test.cjs')], {
    env: { ...isolatedEnvironment(root), INIT_EVENTS: eventsFile, INIT_MODE: mode,
      MEMOCAP_OPENCODE_INTEGRATION: '1', MEMOCAP_TEST_HOST_EVIDENCE: evidenceFile },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 1, child.stdout);
  const evidence = JSON.parse(fs.readFileSync(evidenceFile));
  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
  context.diagnostic(JSON.stringify({ mode, blocker: evidence.blocker, phases: evidence.phases,
    api_requests: evidence.api_requests, commands: evidence.commands, cleanup: evidence.cleanup }));
  return { evidence, events };
}

async function cleaned(evidence, events) {
  assert.equal(evidence.cleanup.host_port_closed, true);
  assert.equal(evidence.cleanup.provider_port_closed, true);
  assert.equal(evidence.cleanup.isolated_root_removed, true);
  assert.equal(evidence.cleanup.package.active_children, 0);
  assert.equal(evidence.request_count, 0);
  assert.match(evidence.cleanup.dispose_error, /dispose sentinel/);
  assert.equal(events.some((entry) => entry.event === 'api_budget' && entry.milliseconds !== 25000), false);
  assert.equal(events.filter((entry) => entry.event === 'command_budget' && entry.milliseconds === 180000).length, 1);
  for (const name of ['listener_ready', 'debug_config', 'host_cleanup', 'provider_cleanup', 'package_cleanup']) {
    const phase = evidence.phases[name];
    assert.ok(Number.isFinite(Date.parse(phase.started_at)));
    assert.ok(Number.isFinite(Date.parse(phase.finished_at)));
    assert.ok(phase.finished_monotonic_ms >= phase.started_monotonic_ms);
    assert.ok(phase.elapsed_ms >= 0);
  }
  assert.ok(evidence.host.stdout_tail.includes('opencode server listening on'));
  assert.ok(evidence.host.stderr_tail.includes('fixture serve stderr'));
  assert.ok(evidence.commands[0].stderr_tail.includes('fixture config stderr'));
  assert.equal(await portClosed(evidence.host.url), true);
  assert.equal(fs.existsSync(events.find((entry) => entry.event === 'root').root), false);
  for (const pid of new Set(events.filter((entry) => entry.pid).map((entry) => entry.pid))) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
}

test('host initialization ordering completes config before actual first HTTP and stops before model', async (context) => {
  const { evidence, events } = orchestration(context, 'success');
  assert.equal(events.some((entry) => entry.event === 'http_before_config'), false);
  assert.ok(events.findIndex((entry) => entry.event === 'config_finish') < events.findIndex((entry) => entry.event === '/command'));
  assert.match(evidence.blocker.message, /CONTROLLED_NEXT_ENDPOINT/);
  assert.deepEqual(evidence.loaded_commands.map((command) => command.name), ['memory']);
  assert.equal(evidence.phases.first_command.status, 'completed');
  assert.ok(evidence.phases.listener_ready.finished_monotonic_ms <= evidence.phases.debug_config.started_monotonic_ms);
  assert.ok(evidence.phases.debug_config.finished_monotonic_ms <= evidence.phases.first_command.started_monotonic_ms);
  assert.equal(events.filter((entry) => entry.event === 'config_enter').length, 1);
  await cleaned(evidence, events);
});

for (const mode of ['config_exit', 'config_timeout']) {
  test(`host initialization ordering prevents first HTTP after ${mode}`, async (context) => {
    const { evidence, events } = orchestration(context, mode);
    assert.equal(events.some((entry) => entry.event === '/command'), false);
    assert.equal(events.filter((entry) => entry.event === 'config_enter').length, 1);
    assert.equal(evidence.commands[0].code, mode === 'config_exit' ? 23 : null);
    assert.equal(Boolean(evidence.commands[0].timed_out), mode === 'config_timeout');
    assert.equal(evidence.phases.debug_config.status, 'failed');
    assert.equal(evidence.phases.first_command, undefined);
    await cleaned(evidence, events);
  });
}

for (const mode of ['http_hang', 'body_hang']) {
  test(`host initialization ordering still aborts actual first HTTP without retry for ${mode}`, async (context) => {
    const { evidence, events } = orchestration(context, mode);
    assert.equal(events.filter((entry) => entry.event === 'config_finish').length, 1);
    assert.equal(events.filter((entry) => entry.event === '/command').length, 1);
    assert.match(evidence.blocker.message, /timeout|aborted/i);
    assert.equal(evidence.loaded_commands, undefined);
    assert.equal(evidence.phases.first_command.status, 'failed');
    assert.equal(evidence.api_requests[0].abort_phase, mode === 'http_hang' ? 'fetch' : 'body_read');
    assert.equal(evidence.api_requests[0].aborted, true);
    await cleaned(evidence, events);
  });
}
