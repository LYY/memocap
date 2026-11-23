const assert = require('node:assert/strict');
const test = require('node:test');
const { entry, prerequisites } = require('./entry.cjs');
const { Budget, providerFetch } = require('./transport.cjs');
const { diagnostics } = require('./diagnostics.cjs');

const valid = () => ({ enabled: true, profileRef: '/task/model-only.json', credentialRef: 'native-reference',
  consent: 'quality-native-canary-v1:fresh-bounded-runtime', existingCapability: true,
  providerDestinations: ['https://provider.invalid/v1/responses'], authDestinations: [] });

test('entry skips without its own opt-in and never accepts the old quality flag', () => {
  const result = entry({ MEMOCAP_CAPTURE_QUALITY: '1' });
  assert.equal(result.status, 'not_run');
  assert.equal(result.reason, 'explicit_opt_in_required');
});

for (const [field, reason] of [['profileRef', 'model_only_profile_required'],
  ['credentialRef', 'credential_reference_required'], ['consent', 'fresh_consent_required'],
  ['providerDestinations', 'precise_destinations_required'], ['authDestinations', 'auth_destinations_unknown'],
  ['existingCapability', 'existing_capability_unconfirmed']]) {
  test(`entry rejects before runtime access when ${field} is missing`, () => {
    const input = valid();
    delete input[field];
    assert.equal(entry(input).reason, reason);
    assert.equal(entry(input).execution.host_starts, 0);
  });
}

test('complete declarations still require fresh runtime approval and do not claim quality', () => {
  assert.equal(entry(valid()).reason, 'runtime_approval_required');
  assert.equal(entry(valid()).quality_pass, false);
});

for (const destination of ['https://user:secret@provider.invalid/v1', 'https://provider.invalid/*',
  'http://provider.invalid/v1', 'https://provider.invalid/v1?key=secret']) {
  test('destination parser rejects broad or credential-bearing destinations without echo', () => {
    const input = { ...valid(), providerDestinations: [destination] };
    const result = entry(input);
    assert.equal(result.reason, 'precise_destinations_required');
    assert.equal(JSON.stringify(result).includes(destination), false);
  });
}

test('budget charges every failed outgoing attempt and terminally prevents retries', async () => {
  const budget = new Budget(() => 0);
  const send = providerFetch({ budget, destinations: valid().providerDestinations,
    transport: async () => { throw new TypeError('credential-shaped hidden detail'); } });
  await assert.rejects(send('https://provider.invalid/v1/responses'), { code: 'dispatch_uncertain' });
  await assert.rejects(send('https://provider.invalid/v1/responses'), { code: 'dispatch_uncertain' });
  assert.equal(budget.snapshot().dispatches, 1);
});

test('budget blocks the 21st natural outgoing attempt before the transport', async () => {
  const budget = new Budget(() => 0);
  const send = providerFetch({ budget, destinations: valid().providerDestinations,
    transport: async () => new Response('{}') });
  for (let index = 0; index < 20; index++) await send('https://provider.invalid/v1/responses');
  await assert.rejects(send('https://provider.invalid/v1/responses'), { code: 'natural_dispatch_budget' });
  assert.equal(budget.snapshot().dispatches, 20);
});

test('fixed support quota and total quota count at fetch, independently of control calls', async () => {
  const budget = new Budget(() => 0);
  for (let index = 0; index < 20; index++) budget.dispatch('natural');
  const send = providerFetch({ budget, destinations: valid().providerDestinations,
    group: 'support', transport: async () => new Response('{}') });
  for (let index = 0; index < 8; index++) await send('https://provider.invalid/v1/responses');
  await assert.rejects(send('https://provider.invalid/v1/responses'), { code: 'total_dispatch_budget' });
  assert.equal(budget.snapshot().dispatches, 28);
});

for (const reason of ['permission_denied', 'isolation_unknown', 'unexpected_write', 'dispatch_uncertain']) {
  test(`terminal ${reason} cannot be reset by another review or host`, () => {
    const budget = new Budget(() => 0);
    budget.stop(reason);
    assert.throws(() => budget.host('pure'), { code: reason });
    assert.throws(() => budget.review('another'), { code: reason });
  });
}

test('unknown destination is blocked without a dispatch', async () => {
  const budget = new Budget(() => 0);
  const send = providerFetch({ budget, destinations: valid().providerDestinations,
    transport: async () => assert.fail('must not dispatch') });
  await assert.rejects(send('https://elsewhere.invalid/'), { code: 'unexpected_destination' });
  assert.equal(budget.snapshot().dispatches, 0);
});

test('redirect is terminal and cannot silently reach another destination', async () => {
  const budget = new Budget(() => 0);
  const send = providerFetch({ budget, destinations: valid().providerDestinations,
    transport: async (_input, options) => {
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302 });
    } });
  await assert.rejects(send('https://provider.invalid/v1/responses'), { code: 'unexpected_destination' });
});

test('host starts are finite, pure cannot generate, and nonpure requires proved isolation', () => {
  const budget = new Budget(() => 0);
  budget.host('pure');
  assert.throws(() => budget.dispatch('natural'), { code: 'pure_generation_forbidden' });
});

test('all setup writes share the three attempt ceiling', () => {
  const budget = new Budget(() => 0);
  for (let index = 0; index < 3; index++) budget.write('setup');
  assert.throws(() => budget.write('setup'), { code: 'write_budget' });
  assert.equal(budget.snapshot().writes, 3);
});

test('review retains child, generation, single write and deadline ceilings', () => {
  let now = 0;
  const budget = new Budget(() => now);
  budget.review('review-1');
  budget.child(); budget.child();
  budget.generation(); budget.generation(); budget.generation();
  budget.write('natural');
  now = 30000;
  assert.throws(() => budget.generation(), { code: 'review_timeout' });
});

test('wall time includes setup and preflight', () => {
  let now = 0;
  const budget = new Budget(() => now);
  now = 300000;
  assert.throws(() => budget.host('pure'), { code: 'batch_timeout' });
});

test('missing optional origins are unavailable rather than an empty safe list', () => {
  const result = diagnostics({ status: 200, contentType: 'application/json', bytes: 2,
    result: { data: { plugin: [], mcp: {} } } }, []);
  assert.equal(result.origins.presence, 'unavailable');
  assert.equal(result.isolation, 'unknown');
});

test('nonOK and exception metadata never retain error strings or whole SDK values', () => {
  const result = diagnostics({ status: 401, contentType: 'text/html; secret', bytes: 12,
    result: { error: { message: 'SECRET', headers: 'SECRET' } }, exception: new TypeError('SECRET') }, []);
  assert.equal(result.http_status, 401);
  assert.equal(result.exception_class, 'TypeError');
  assert.equal(result.error_present, true);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('declared prerequisites are validation only, never authorization proof', () => {
  assert.equal(prerequisites(valid()).status, 'declared_only');
});

test('SDK null result remains safe unknown diagnostics', () => {
  const result = diagnostics({ result: null }, []);
  assert.equal(result.data_present, false);
  assert.equal(result.isolation, 'unknown');
});

for (const [method, count, code] of [['child', 2, 'review_child_budget'],
  ['generation', 3, 'review_generation_budget'], ['write', 1, 'review_write_budget']]) {
  test(`review ${method} cannot exceed its original finite limit`, () => {
    const budget = new Budget(() => 0);
    budget.review('review');
    for (let index = 0; index < count; index++) budget[method]('natural');
    assert.throws(() => budget[method]('natural'), { code });
  });
}

test('only one pure and one proved nonpure host can be charged', () => {
  const budget = new Budget(() => 0);
  budget.host('pure');
  budget.host('nonpure', 'proved');
  assert.throws(() => budget.host('nonpure', 'proved'), { code: 'host_budget' });
});

test('unproved nonpure isolation terminally blocks before startup', () => {
  const budget = new Budget(() => 0);
  budget.host('pure');
  assert.throws(() => budget.host('nonpure'), { code: 'isolation_unknown' });
});

test('outgoing attempt accounting retains review correlation even when transport fails', async () => {
  const budget = new Budget(() => 0);
  budget.review('actual-review-token');
  const send = providerFetch({ budget, destinations: valid().providerDestinations,
    transport: async () => { throw new TypeError('withheld'); } });
  await assert.rejects(send('https://provider.invalid/v1/responses'), { code: 'dispatch_uncertain' });
  assert.deepEqual(budget.snapshot().attempts, [{ ordinal: 1, group: 'natural', review_id: 'actual-review-token' }]);
});
