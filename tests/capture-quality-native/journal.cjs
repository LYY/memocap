const fs = require('node:fs');
const { CanaryBlocked } = require('./entry.cjs');
const { matchesReadback } = require('./projection.cjs');

class SharedBudget {
  constructor(file, { io = fs, clock = Date.now } = {}) { this.file = file; this.io = io; this.clock = clock; }
  static consume(file, identity, options) {
    const budget = new SharedBudget(file, options);
    const state = { schema: 1, ...identity, consumed: true, began: budget.clock(), terminal: null,
      pure: 0, nonpure: 0, dispatches: 0, natural: 0, support: 0, writes: 0,
      sessions: {}, roots: {}, reviews: {}, slots: {}, events: [], write_attempts: [] };
    try { budget.io.writeFileSync(file, JSON.stringify(state), { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) {
      if (error instanceof Error && error.code === 'EEXIST') throw new CanaryBlocked('attempt_consumed');
      throw new CanaryBlocked('attempt_persistence_failed');
    }
    return budget;
  }
  snapshot() {
    const state = JSON.parse(this.io.readFileSync(this.file, 'utf8'));
    if (this.io.existsSync(`${this.file}.stop`)) state.terminal ||= 'budget_lock_contended';
    return state;
  }
  change(action, cleanup = false) {
    const lock = `${this.file}.lock`;
    try { this.io.mkdirSync(lock); }
    catch (error) {
      if (!(error instanceof Error) || error.code !== 'EEXIST') throw new CanaryBlocked('budget_persistence_failed');
      this.io.writeFileSync(`${this.file}.stop`, 'budget_lock_contended', { mode: 0o600, flush: true });
      throw new CanaryBlocked('budget_lock_contended');
    }
    let fault;
    let result;
    try {
      const state = this.snapshot();
      const fail = (code) => { state.terminal ||= code; throw new CanaryBlocked(state.terminal); };
      try {
        if (!cleanup && state.terminal) fail(state.terminal);
        if (!cleanup && this.clock() - state.began >= 300000) fail('batch_timeout');
        result = action(state, fail);
      } catch (error) { fault = error; }
      this.io.writeFileSync(`${this.file}.next`, JSON.stringify(state), { mode: 0o600, flush: true });
      this.io.renameSync(`${this.file}.next`, this.file);
    } finally { this.io.rmdirSync(lock); }
    if (fault) throw fault;
    return result;
  }
  stop(code) { this.change((state) => { state.terminal ||= code; }, true); }
  host(mode) {
    this.change((state, fail) => {
      switch (mode) {
        case 'pure': if (state.pure || state.nonpure) fail('host_budget'); state.pure++; break;
        case 'nonpure': if (state.nonpure) fail('host_budget'); state.nonpure++; break;
        default: fail('unknown_host_mode');
      }
      state.mode = mode;
    });
  }
  root(session, user, slot = null) {
    return this.change((state, fail) => {
      if (!session || !user || state.sessions[session]?.stage) fail('review_identity');
      const key = `${session}:${user}`;
      if (state.reviews[key]) fail('review_identity_reused');
      state.roots[session] = key;
      state.sessions[session] = { root: session, review: null, slot };
      state.reviews[key] = { session, user, slot, began: null, children: 0, generations: 0, dispatches: 0, writes: 0 };
      return key;
    });
  }
  reserveChild(parent) {
    this.change((state, fail) => {
      const review = state.reviews[state.roots[parent]];
      if (!review) fail('review_identity');
      review.began ??= this.clock();
      if (this.clock() - review.began >= 30000) fail('review_timeout');
      if (review.children >= 2) fail('review_child_budget');
      review.children++;
    });
  }
  child(id, parent, stage) { this.reserveChild(parent); return this.bindChild(id, parent, stage); }
  bindChild(id, parent, stage) {
    return this.change((state, fail) => {
      const key = state.roots[parent];
      const review = state.reviews[key];
      if (!review || state.sessions[id] || !['extract', 'commit', 'maintenance_review', 'maintenance_commit'].includes(stage)) fail('review_identity');
      if (this.clock() - review.began >= 30000) fail('review_timeout');
      state.sessions[id] = { root: parent, review: key, stage, slot: review.slot };
      return key;
    });
  }
  generation(id) {
    this.change((state, fail) => {
      const binding = state.sessions[id];
      if (!binding) fail('generation_identity');
      if (!binding.review) return;
      const review = state.reviews[binding.review];
      if (this.clock() - review.began >= 30000) fail('review_timeout');
      if (review.generations >= 3) fail('review_generation_budget');
      review.generations++;
    });
  }
  dispatch(id, destinationKind) {
    return this.change((state, fail) => {
      if (state.mode === 'pure') fail('pure_generation_forbidden');
      const binding = id ? state.sessions[id] : null;
      if (id && !binding) fail('dispatch_identity');
      const review = binding?.review ? state.reviews[binding.review] : null;
      if (review && this.clock() - review.began >= 30000) fail('review_timeout');
      if (review?.dispatches >= 3) fail('review_dispatch_budget');
      const group = destinationKind === 'provider' && binding?.stage === 'support' ? 'support' : 'natural';
      if (state.dispatches >= 28) fail('total_dispatch_budget');
      if (state[group] >= (group === 'support' ? 8 : 20)) fail(`${group}_dispatch_budget`);
      if (group === 'support') {
        if (!binding.slot || state.slots[binding.slot]) fail('support_slot_dispatch_budget');
        state.slots[binding.slot] = 1;
      }
      state.dispatches++; state[group]++;
      if (review) review.dispatches++;
      const attempt = { ordinal: state.dispatches, group, session: id ?? null,
        review: binding?.review ?? null, slot: binding?.slot ?? null, destination_kind: destinationKind };
      state.events.push({ kind: 'provider.dispatch', ...attempt });
      return attempt;
    });
  }
  support(id) {
    this.change((state, fail) => {
      const binding = state.sessions[id];
      if (!binding?.slot || binding.stage !== 'extract') fail('support_stage_identity');
      binding.stage = 'support';
    });
  }
  write(id, setup = false) {
    return this.change((state, fail) => {
      if (state.writes >= 3) fail('write_budget');
      state.writes++;
      if (setup) return state.writes;
      const binding = state.sessions[id];
      const review = binding?.review ? state.reviews[binding.review] : null;
      if (!review || binding.slot || !['commit', 'maintenance_commit'].includes(binding.stage)) fail('unexpected_write');
      if (this.clock() - review.began >= 30000) fail('review_timeout');
      if (review.writes >= 1) fail('review_write_budget');
      review.writes++;
      return state.writes;
    });
  }
  dispatchWrite(attempt, identity) {
    this.change((state, fail) => {
      if (!Number.isInteger(attempt) || attempt < 1 || attempt > state.writes ||
          state.write_attempts.some((write) => write.attempt === attempt)) fail('native_write_attempt_identity');
      state.write_attempts.push({ attempt, ...identity, status: 'dispatched', receipt: null });
    });
  }
  recordWrite(attempt, receipt) {
    this.change((state, fail) => {
      const write = state.write_attempts.find((item) => item.attempt === attempt);
      if (!write || write.status !== 'dispatched') fail('native_write_attempt_identity');
      write.receipt = receipt; write.status = 'awaiting_readback';
    }, true);
  }
  verifyWrite(attempt, checked) {
    this.change((state, fail) => {
      const write = state.write_attempts.find((item) => item.attempt === attempt);
      if (write?.status !== 'awaiting_readback' || write.command !== 'remember' ||
          !matchesReadback(checked, write.receipt.records[0])) fail('independent_readback_mismatch');
      write.status = 'verified'; write.readback_operation_id = checked.operation_id;
    }, true);
  }
  event(event) {
    this.change((state, fail) => {
      if (state.events.length >= 1000 || Buffer.byteLength(JSON.stringify(event)) > 131072) fail('observation_budget');
      state.events.push(event);
    }, true);
  }
}

module.exports = { SharedBudget };
