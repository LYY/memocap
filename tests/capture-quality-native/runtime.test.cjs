const test = require('node:test');
const assert = require('node:assert/strict');
const { entry } = require('./entry.cjs');
const { memoryIO } = require('./fakes.cjs');

test('complete old declarations request concrete runtime inputs rather than a blanket unavailable backend', () => {
  const input = { enabled: true, profileRef: '/task/model.json', credentialRef: 'native-reference',
    consent: 'quality-native-canary-v1:fresh-bounded-runtime', existingCapability: true,
    providerDestinations: ['https://provider.invalid/responses'], authDestinations: [] };
  const result = entry(input);
  assert.equal(result.reason, 'runtime_approval_required');
  assert.equal(result.execution.host_starts, 0);
});

test('consumption survives reopening the shared journal and refuses a second batch start', () => {
  const { SharedBudget } = require('./journal.cjs');
  const io = memoryIO();
  SharedBudget.consume('/attempt', { batch: 'one', fingerprint: 'digest' }, { io, clock: () => 10 });
  assert.throws(() => SharedBudget.consume('/attempt', { batch: 'one', fingerprint: 'digest' }, { io }),
    { code: 'attempt_consumed' });
  assert.equal(new SharedBudget('/attempt', { io }).snapshot().batch, 'one');
});

test('provider retries share a native review budget across independent budget instances', () => {
  const { SharedBudget } = require('./journal.cjs');
  const io = memoryIO();
  const first = SharedBudget.consume('/attempt', { batch: 'one', fingerprint: 'digest' }, { io, clock: () => 0 });
  first.host('nonpure');
  first.root('root', 'user');
  first.child('extract', 'root', 'extract');
  const second = new SharedBudget('/attempt', { io, clock: () => 0 });
  for (let index = 0; index < 3; index++) second.dispatch('extract', 'provider');
  assert.throws(() => first.dispatch('extract', 'provider'), { code: 'review_dispatch_budget' });
  assert.equal(second.snapshot().dispatches, 3);
  assert.equal(second.snapshot().terminal, 'review_dispatch_budget');
});

test('root work consumes only batch allowance and review time begins with the first real child', () => {
  const { SharedBudget } = require('./journal.cjs');
  let now = 0;
  const budget = SharedBudget.consume('/attempt', { batch: 'one' }, { io: memoryIO(), clock: () => now });
  budget.host('nonpure'); budget.root('root', 'user');
  for (let index = 0; index < 4; index++) budget.dispatch('root', 'provider');
  now = 45000;
  budget.child('extract', 'root', 'extract');
  budget.dispatch('extract', 'provider');
  assert.equal(budget.snapshot().reviews['root:user'].dispatches, 1);
  assert.equal(budget.snapshot().reviews['root:user'].began, 45000);
  assert.equal(budget.snapshot().natural, 5);
});

test('auth refresh during support charges natural allowance and leaves exactly one support dispatch', () => {
  const { SharedBudget } = require('./journal.cjs');
  const budget = SharedBudget.consume('/attempt', { batch: 'one' }, { io: memoryIO() });
  budget.host('nonpure'); budget.root('root', 'user', 'slot'); budget.child('extract', 'root', 'extract');
  budget.support('extract');
  budget.dispatch('extract', 'auth');
  budget.dispatch('extract', 'provider');
  assert.equal(budget.snapshot().natural, 1);
  assert.equal(budget.snapshot().support, 1);
  assert.throws(() => budget.dispatch('extract', 'provider'), { code: 'support_slot_dispatch_budget' });
});

test('an actual denial is terminal for every process and support writes never dispatch', () => {
  const { SharedBudget } = require('./journal.cjs');
  const io = memoryIO();
  const budget = SharedBudget.consume('/attempt', { batch: 'one', fingerprint: 'digest' }, { io, clock: () => 0 });
  budget.root('root', 'user', 'challenge');
  budget.child('extract', 'root', 'extract');
  assert.throws(() => budget.write('extract'), { code: 'unexpected_write' });
  assert.equal(budget.snapshot().writes, 1);
  assert.throws(() => new SharedBudget('/attempt', { io, clock: () => 0 }).dispatch('extract', 'provider'),
    { code: 'unexpected_write' });
});

test('the durable aggregate admits at most twenty natural plus eight distinct support attempts', () => {
  const { SharedBudget } = require('./journal.cjs');
  const budget = SharedBudget.consume('/attempt', { batch: 'one' }, { io: memoryIO() });
  budget.host('nonpure');
  for (let index = 0; index < 20; index++) budget.dispatch(null, 'provider');
  for (let index = 0; index < 8; index++) {
    budget.root(`root-${index}`, `user-${index}`, `slot-${index}`);
    budget.child(`child-${index}`, `root-${index}`, 'extract'); budget.support(`child-${index}`);
    budget.dispatch(`child-${index}`, 'provider');
  }
  assert.equal(budget.snapshot().dispatches, 28);
  assert.throws(() => budget.dispatch(null, 'provider'), { code: 'total_dispatch_budget' });
});

test('setup reservations share the three-write ceiling and lock contention is persistently terminal', () => {
  const { SharedBudget } = require('./journal.cjs');
  const io = memoryIO();
  const budget = SharedBudget.consume('/attempt', { batch: 'one' }, { io });
  budget.write(null, true); budget.write(null, true); budget.write(null, true);
  assert.throws(() => budget.write(null, true), { code: 'write_budget' });
  const other = SharedBudget.consume('/other', { batch: 'two' }, { io });
  io.mkdirSync('/other.lock');
  assert.throws(() => other.dispatch(null, 'provider'), { code: 'budget_lock_contended' });
  assert.equal(new SharedBudget('/other', { io }).snapshot().terminal, 'budget_lock_contended');
});

test('repeated native user identity cannot replenish a review budget', () => {
  const { SharedBudget } = require('./journal.cjs');
  const budget = SharedBudget.consume('/attempt', { batch: 'one' }, { io: memoryIO() });
  budget.root('root', 'user'); budget.child('extract', 'root', 'extract');
  assert.throws(() => budget.root('root', 'user'), { code: 'review_identity_reused' });
  assert.equal(budget.snapshot().reviews['root:user'].children, 1);
});
