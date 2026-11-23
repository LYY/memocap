const { CanaryBlocked, exactDestinations } = require('./entry.cjs');

class Budget {
  constructor(clock = () => performance.now()) {
    this.clock = clock;
    this.began = clock();
    this.state = { dispatches: 0, natural: 0, support: 0, writes: 0, pure: 0, nonpure: 0, terminal: null };
    this.current = null;
    this.mode = null;
    this.attempts = [];
    this.controller = new AbortController();
  }
  stop(reason) {
    this.state.terminal ||= reason;
    this.controller.abort();
  }
  fail(reason) { this.stop(reason); throw new CanaryBlocked(this.state.terminal); }
  check() {
    if (this.state.terminal) throw new CanaryBlocked(this.state.terminal);
    if (this.clock() - this.began >= 300000) this.fail('batch_timeout');
    if (this.current && this.clock() - this.current.began >= 30000) this.fail('review_timeout');
  }
  host(mode, isolation = 'unknown') {
    this.check();
    switch (mode) {
      case 'pure':
        if (this.state.pure || this.state.nonpure) this.fail('host_budget');
        this.state.pure++;
        break;
      case 'nonpure':
        if (isolation !== 'proved') this.fail('isolation_unknown');
        if (this.state.pure !== 1 || this.state.nonpure) this.fail('host_budget');
        this.state.nonpure++;
        break;
      default: this.fail('unknown_host_mode');
    }
    this.mode = mode;
  }
  review(id) {
    this.check();
    if (typeof id !== 'string' || !id || this.current) this.fail('review_identity');
    this.current = { id, began: this.clock(), children: 0, generations: 0, writes: 0 };
  }
  finishReview() { this.check(); this.current = null; }
  child() {
    this.check();
    if (!this.current || this.current.children >= 2) this.fail('review_child_budget');
    this.current.children++;
  }
  generation() {
    this.check();
    if (!this.current || this.current.generations >= 3) this.fail('review_generation_budget');
    this.current.generations++;
  }
  dispatch(group) {
    this.check();
    if (this.mode === 'pure') this.fail('pure_generation_forbidden');
    if (this.state.dispatches >= 28) this.fail('total_dispatch_budget');
    switch (group) {
      case 'natural': if (this.state.natural >= 20) this.fail('natural_dispatch_budget'); break;
      case 'support': if (this.state.support >= 8) this.fail('support_dispatch_budget'); break;
      default: this.fail('unknown_dispatch_group');
    }
    this.state[group]++;
    const ordinal = ++this.state.dispatches;
    this.attempts.push({ ordinal, group, review_id: this.current?.id ?? null });
    return ordinal;
  }
  write(kind) {
    this.check();
    if (this.state.writes >= 3) this.fail('write_budget');
    switch (kind) {
      case 'setup': break;
      case 'natural':
        if (!this.current || this.current.writes >= 1) this.fail('review_write_budget');
        this.current.writes++;
        break;
      default:
        this.state.writes++;
        this.fail('unexpected_write');
    }
    this.state.writes++;
  }
  snapshot() { return { ...this.state, attempts: this.attempts.map((attempt) => ({ ...attempt })) }; }
}

function providerFetch({ budget, destinations, transport, group = 'natural' }) {
  if (!exactDestinations(destinations) || !destinations.length) throw new CanaryBlocked('precise_destinations_required');
  return async (input, init = {}) => {
    budget.check();
    const destination = input instanceof Request ? input.url : String(input);
    if (!destinations.includes(destination)) budget.fail('unexpected_destination');
    budget.dispatch(group);
    const remaining = Math.min(300000 - (budget.clock() - budget.began),
      budget.current ? 30000 - (budget.clock() - budget.current.began) : 300000);
    const signal = AbortSignal.any([budget.controller.signal, AbortSignal.timeout(Math.max(1, Math.floor(remaining))),
      ...(init.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])]);
    let response;
    try { response = await transport(input, { ...init, redirect: 'manual', signal }); }
    catch (error) {
      if (error instanceof CanaryBlocked) throw error;
      budget.fail('dispatch_uncertain');
    }
    if (response.status >= 300 && response.status < 400) budget.fail('unexpected_destination');
    budget.check();
    return response;
  };
}

module.exports = { Budget, providerFetch };
