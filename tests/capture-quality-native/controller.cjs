const fs = require('node:fs');
const path = require('node:path');
const { approve, hash, root } = require('./approval.cjs');
const { entry, CanaryBlocked } = require('./entry.cjs');
const { SharedBudget } = require('./journal.cjs');
const { startHost, environment } = require('./host.cjs');
const { carrierPlan } = require('./input.cjs');
const { supportSchedule } = require('./support.cjs');
const { invokeNative } = require('./native-proxy.cjs');
const { digest, readbackReceipt, joinReadRoute } = require('./projection.cjs');

function fixtures(io = fs) {
  const bytes = io.readFileSync(path.join(root, 'tests/capture-evaluation/tuning.json'));
  const contract = JSON.parse(io.readFileSync(path.join(root, 'tests/capture-evaluation/native-driver-contract.json'), 'utf8'));
  if (hash(bytes) !== contract.adapter.input_sha256) throw new CanaryBlocked('frozen_tuning_hash_changed');
  return { tuning: JSON.parse(bytes.toString('utf8')), contract };
}

function prepareOwned(input, approval, contract, io = fs) {
  const paths = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'tmp', 'project']
    .map((key) => [key, path.join(input.privateRoot, key)]));
  io.mkdirSync(input.privateRoot, { mode: 0o700 });
  try {
    for (const directory of Object.values(paths)) io.mkdirSync(directory, { mode: 0o700 });
    paths.database = path.join(input.privateRoot, 'memory.sqlite');
    paths.control = path.join(input.privateRoot, 'control.json');
    paths.launcher = path.join(input.privateRoot, 'native-launcher.cjs');
    io.mkdirSync(path.join(paths.project, 'docs'), { mode: 0o700 });
    io.writeFileSync(paths.launcher, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(__dirname, 'native-proxy.cjs'))}).main();\n`,
      { flag: 'wx', mode: 0o700 });
    io.writeFileSync(paths.control, JSON.stringify({ attempt: input.attemptFile, root,
      nativeBinary: approval.native.path, providerDestinations: input.providerDestinations,
      authDestinations: input.authDestinations, contract }), { flag: 'wx', mode: 0o600 });
    return paths;
  } catch (error) { io.rmSync(input.privateRoot, { recursive: true }); throw error; }
}

async function waitTerminal(budget, session, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (;;) {
    const snapshot = budget.snapshot();
    if (snapshot.terminal) throw new CanaryBlocked(snapshot.terminal);
    const key = snapshot.roots[session];
    const review = snapshot.reviews[key];
    const terminal = snapshot.events.find((event) => event.kind === 'capture.terminal' && event.session === session &&
      event.user === review?.user);
    if (terminal) return terminal;
    if (Date.now() - snapshot.began >= 300000 || review?.began && Date.now() - review.began >= 30000) {
      budget.stop('review_timeout'); throw new CanaryBlocked('review_timeout');
    }
    await delay(50);
  }
}

async function deliver({ host, budget, model, user, slot, session: continuing }, delay) {
  budget.change((state) => { state.active = slot ? { slot: slot.challenge.name,
    challenge: slot.preparation ? null : slot.challenge,
    user_hash: digest(user) } : null; });
  const made = continuing ? { data: { id: continuing } } : await host.client.session.create({ body: { title: 'Native route observation' } });
  if (made.error || !made.data?.id) throw new CanaryBlocked('root_session_create_failed');
  const session = made.data.id;
  budget.change((state) => { state.delivery = { session, user_hash: digest(user) }; });
  budget.event({ kind: 'task.delivery', session, user_hash: digest(user), slot: slot?.challenge.name ?? null,
    stratum: !slot ? 'natural_generation' : slot.preparation ? 'counterfactual_context_preparation' : 'supplied_candidate_counterfactual' });
  const answered = await host.client.session.prompt({ path: { id: session }, signal: AbortSignal.timeout(300000),
    body: { model, agent: 'build', parts: [{ type: 'text', text: user }] } });
  if (answered.error || answered.data?.info?.error || answered.data?.info?.finish !== 'stop') {
    throw new CanaryBlocked('normal_completion_unavailable');
  }
  await waitTerminal(budget, session, delay);
  const messages = await host.client.session.messages({ path: { id: session } });
  if (messages.error || !Array.isArray(messages.data)) throw new CanaryBlocked('native_history_unavailable');
  return { session, messages: messages.data };
}

async function runNative(input, dependencies = {}) {
  const boundary = entry(input);
  if (boundary.status !== 'ready') return boundary;
  const io = dependencies.io ?? fs;
  const approval = (dependencies.approve ?? approve)(input, io);
  const frozen = (dependencies.fixtures ?? fixtures)(io);
  const budget = SharedBudget.consume(input.attemptFile, { batch: approval.batch, fingerprint: approval.fingerprint }, { io });
  const report = { status: 'running', canary: 'not_run', qa7: 'not_run', quality_pass: false,
    runtime_metrics: null, holdout: 'not_accessed', support: supportSchedule(frozen.tuning, frozen.contract),
    maintenance: { status: 'seam_not_reached', quality_credit: false,
      missing: ['original_native_request', 'executable_independent_verification_operation', 'actual_adoption'] },
    cleanup: { hosts_closed: 0, child_aborts: 0, private_root_removed: false } };
  let paths;
  let preparation;
  let host;
  let owned = false;
  const ownership = { exited: true };
  const open = dependencies.startHost ?? startHost;
  let watchdog;
  try {
    paths = prepareOwned(input, approval, frozen.contract, io);
    owned = true;
    preparation = (dependencies.preparePreload ?? require('./preload-preparation.cjs').prepareOwnedPreload)(input.privateRoot, paths, io);
    preparation.recheck();
    ownership.exited = false;
    host = await open({ input, approval, paths, pure: true, budget, ownership, preparation });
    await host.close(); ownership.exited = true; report.cleanup.hosts_closed++; host = null;
    preparation.recheck();
    ownership.exited = false;
    host = await open({ input, approval, paths, pure: false, budget, ownership, preparation });
    watchdog = setInterval(() => {
      const state = budget.snapshot();
      if (Date.now() - state.began >= 300000 && !state.terminal) budget.stop('batch_timeout');
      if (budget.snapshot().terminal) host?.close().catch(() => budget.event({ kind: 'cleanup.watchdog', status: 'failed' }));
    }, 100);
    const plan = carrierPlan(frozen.tuning, paths.project);
    const original = frozen.tuning.capture[0].turns[0];
    const carrier = path.join(paths.project, 'docs/route.md');
    io.writeFileSync(carrier, original.tools[0].output, { flag: 'wx', mode: 0o600 });
    if (hash(io.readFileSync(carrier)) !== hash(original.tools[0].output)) throw new CanaryBlocked('carrier_hash_mismatch');
    report.mapping = plan;
    const natural = await deliver({ host, budget, model: approval.model, user: original.user }, dependencies.delay);
    for (const write of budget.snapshot().write_attempts.filter((attempt) => attempt.command === 'remember' && attempt.receipt)) {
      const record = write.receipt.records[0];
      const { id, placement } = record;
      const checked = (dependencies.invokeNative ?? invokeNative)(['read', String(id), '--placement', placement,
        '--repo', paths.project, '--json'], { attempt: input.attemptFile, nativeBinary: approval.native.path, root },
      { budget, env: environment(input, approval, paths, false) });
      if (checked.status !== 0 || checked.error || checked.signal) throw new CanaryBlocked('independent_readback_failed');
      const readback = readbackReceipt(JSON.parse(checked.stdout), record);
      budget.event({ kind: 'independent.readback', write_operation_id: write.receipt.operation_id,
        exit_code: checked.status, receipt: readback });
      budget.verifyWrite(write.attempt, readback);
    }
    report.read_route = joinReadRoute({ ...natural, events: budget.snapshot().events, bindings: budget.snapshot(),
      expected: original.tools[0].output, carrier });
    report.canary = 'executed_adjudication_pending';
    for (const slot of [...report.support].sort((left, right) => left.original.turns.length - right.original.turns.length)) {
      if (slot.status === 'seam_not_reached') continue;
      let observed;
      slot.mappings = [];
      for (const [index, turn] of slot.original.turns.entries()) {
        for (const source of turn.tools) {
          io.writeFileSync(carrier, source.output, { mode: 0o600 });
          if (hash(io.readFileSync(carrier)) !== hash(source.output)) throw new CanaryBlocked('carrier_hash_mismatch');
          slot.mappings.push({ turn: index + 1, original_locator: source.path, physical_path: carrier, content_hash: hash(source.output) });
        }
        observed = await deliver({ host, budget, model: approval.model, user: turn.user,
          session: observed?.session, slot: { ...slot, preparation: index < slot.original.turns.length - 1 } }, dependencies.delay);
      }
      const events = budget.snapshot().events;
      slot.session = observed.session;
      slot.injected = events.some((event) => event.kind === 'candidate.injected' && event.slot === slot.challenge.name);
      slot.support_dispatches = events.filter((event) => event.kind === 'provider.dispatch' && event.slot === slot.challenge.name &&
        event.group === 'support').length;
      slot.status = slot.injected && slot.support_dispatches === 1 ? 'actual_support_observed_adjudication_pending' : 'seam_not_reached';
      slot.missing = slot.status === 'seam_not_reached' ? 'selected_source_injection_or_support_not_reached' : null;
    }
    report.status = 'executed_adjudication_pending';
  } catch (error) {
    if (error instanceof AggregateError) report.cleanup.permissions_restore = 'failed';
    const reason = error instanceof CanaryBlocked ? error.code : error instanceof AggregateError
      ? 'preload_preparation_restore_failed' : 'native_runtime_failed_details_withheld';
    budget.stop(reason);
    report.status = 'blocked'; report.reason = reason;
  } finally {
    clearInterval(watchdog);
    if (host) {
      for (const [id, binding] of Object.entries(budget.snapshot().sessions)) {
        if (!binding.stage) continue;
        const result = await host.client.session.abort({ path: { id } }).catch(() => ({ error: true }));
        budget.event({ kind: 'cleanup.child_abort', session: id, error: Boolean(result.error) });
        report.cleanup.child_aborts++;
      }
      try { await host.close(); ownership.exited = true; report.cleanup.hosts_closed++; }
      catch {
        ownership.exited = false; report.status = 'blocked'; report.reason = 'cleanup_exit_unknown';
        budget.stop('cleanup_exit_unknown');
      }
    }
    report.budget = budget.snapshot();
    const unresolved = report.budget.write_attempts.filter((write) => write.status !== 'verified');
    const uncertainWrite = unresolved.length > 0;
    report.cleanup.unresolved_write_attempts = unresolved.map((write) => write.attempt);
    if (uncertainWrite) report.cleanup.readback_recovery_required = true;
    report.cleanup.host_exit_confirmed = ownership.exited;
    if (owned && ownership.exited && !uncertainWrite && report.cleanup.permissions_restore !== 'failed' && io.existsSync(input.privateRoot)) {
      try {
        preparation?.restore();
        report.cleanup.permissions_restore = preparation ? 'restored' : 'not_required';
      } catch {
        report.cleanup.permissions_restore = 'failed';
        report.status = 'blocked'; report.reason = 'cleanup_preload_restore_failed';
        budget.stop('cleanup_preload_restore_failed'); report.budget = budget.snapshot();
      }
      if (report.cleanup.permissions_restore !== 'failed') {
        io.rmSync(input.privateRoot, { recursive: true, force: false });
        report.cleanup.private_root_removed = true;
      }
    }
  }
  report.support = report.support.map((slot) => {
    const result = { ...slot, name: slot.challenge.name };
    delete result.challenge; delete result.original;
    if (result.status === 'deliverable_read_carrier') { result.status = 'seam_not_reached'; result.missing = 'batch_stopped_before_delivery'; }
    return result;
  });
  return report;
}

module.exports = { runNative, prepareOwned, deliver, fixtures, waitTerminal };
