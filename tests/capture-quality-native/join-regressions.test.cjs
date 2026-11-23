const test = require('node:test');
const assert = require('node:assert/strict');
const { joined } = require('./join-fakes.cjs');
const { joinReadRoute } = require('./projection.cjs');

for (const [name, mutate] of [
  ['wrong completed native tool', (fake) => { fake.events[6].tool = 'write_file'; }],
  ['unrelated packet current user', (fake) => { fake.events[0].packet.current_user_id = 'other-user'; }],
  ['unregistered extraction child', (fake) => { fake.events[0].session = 'other-child'; }],
  ['extraction child from another root', (fake) => { fake.bindings.sessions.extract.root = 'other-root'; }],
  ['extraction child from another review', (fake) => { fake.bindings.sessions.extract.review = 'root:old-user'; }],
  ['commit child from another review', (fake) => { fake.bindings.sessions.commit.review = 'root:old-user'; }],
  ['unrelated native returned record', (fake) => { fake.events[3].receipt.records[0].id = 99; fake.events[3].receipt.returned_ids = [99]; }],
  ['unrelated native placement', (fake) => { fake.events[3].receipt.records[0].placement = 'domain:other'; }],
  ['unrelated native content', (fake) => { fake.events[3].receipt.records[0].content_hash = 'other'; }],
  ['unrelated native tags', (fake) => { fake.events[3].receipt.records[0].tags_hash = 'other'; }],
  ['failed independent readback', (fake) => { fake.events[4].receipt.status = 'failed'; }],
  ['failed independent read process', (fake) => { fake.events[4].exit_code = 1; }],
  ['readback from a write operation', (fake) => { fake.events[4].receipt.operation = 'remember'; }],
  ['truncated independent readback', (fake) => { fake.events[4].receipt.truncated = true; }],
  ['partial independent record', (fake) => { fake.events[4].receipt.records[0].completeness = 'partial'; }],
  ['readback error', (fake) => { fake.events[4].receipt.error_code = 'read_failed'; }],
  ['wrong readback returned ID', (fake) => { fake.events[4].receipt.returned_ids = [99]; }],
  ['unrelated root completion', (fake) => { fake.messages[1].info.sessionID = 'other-root'; }],
  ['partial selected source', (fake) => { fake.events[0].packet.sources[0].completeness = 'partial'; }],
  ['source absent from selected bundle', (fake) => { fake.events[0].packet.bundles = []; }],
  ['missing independent read operation identity', (fake) => { fake.events[4].receipt.operation_id = null; }],
  ['missing commit message identity', (fake) => {
    for (const index of [1, 2, 3, 6]) fake.events[index].message = undefined;
  }],
  ['missing actual native call identity', (fake) => { fake.events[5].call = undefined; fake.events[6].call = undefined; }],
]) {
  test(`NATIVE-VERIFY-003 refuses ${name}`, () => {
    const fake = joined();
    mutate(fake);
    assert.equal(joinReadRoute(fake).status, 'seam_not_reached');
  });
}

test('NATIVE-VERIFY-003 selects the actual current root user when older messages are present', () => {
  const fake = joined();
  fake.messages.unshift({ info: { role: 'user', id: 'old-user', sessionID: 'root' }, parts: [] });
  assert.equal(joinReadRoute(fake).status, 'native_join_verified_adjudication_pending');
});

test('NATIVE-VERIFY-003 matching complete identities retain no automatic quality credit', () => {
  const result = joinReadRoute(joined());
  assert.equal(result.status, 'native_join_verified_adjudication_pending');
  assert.equal(result.user_id, 'user');
  assert.equal(result.quality_credit, false);
});
