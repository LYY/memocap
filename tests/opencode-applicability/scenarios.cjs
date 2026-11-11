const assert = require('node:assert/strict');
const fs = require('node:fs');
const { reference } = require('../opencode-v1/discovery.cjs');

function events(journal) {
  return fs.readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

async function runCase(current, specification) {
  const { host, provider, journal, seeds, evidence } = current;
  const session = await host.api('/session', { title: `Synthetic applicability ${specification.name}` });
  const ownEvents = () => events(journal).filter((event) => event.session === session.id);
  const selected = seeds.filter((seed) => seed.key === specification.key);
  let initial;
  const decide = (action, argumentsForCall) => ({ get tool() {
    if (!initial) {
      initial = reference(provider.requests.at(-1).body.messages.findLast((message) => message.role === 'user'));
      assert.equal(initial.status, 'ok');
      assert.deepEqual(initial.discovery, { kind: 'library' });
      for (const seed of selected) {
        const entry = initial.references.find((candidate) => candidate.id === seed.id);
        assert.ok(entry, `missing synthetic record ${seed.fixture_id}`);
        assert.equal(entry.placement, seed.placement);
      }
      for (const entry of initial.references) {
        assert.equal(entry.applicability, 'unknown');
        assert.equal(entry.completeness, specification.key === 'long' ? 'partial' : 'full');
      }
    }
    return action();
  }, get args() { return argumentsForCall(); } });
  const source = (key) => decide(() => 'fixture_source', () => ({ key }));
  const destination = () => {
    const observed = ownEvents().findLast((event) => event.phase === 'source_read');
    assert.ok(observed, 'current source must be read before scripted dispatch');
    assert.equal(observed.source.prohibited, undefined);
    return { environment: observed.source.environment, entry: observed.source.entry };
  };
  const finish = { get text() { return JSON.stringify({ fixture_policy: specification.name, complete: true }); } };
  switch (specification.mode) {
    case 'source':
      provider.responses.push(source(specification.source), { tool: 'fixture_destination', get args() { return destination(); } }, finish);
      break;
    case 'origin':
      provider.responses.push(decide(() => 'memocap_recall', () => ({
        query: specification.query, placements: [selected[0].placement] })), { get text() {
        const receipt = ownEvents().findLast((event) => event.tool === 'memocap_recall').receipt;
        assert.deepEqual(receipt.discovery, { kind: 'origins', placements: [selected[0].placement] });
        assert.deepEqual(receipt.returned_ids, [selected[0].id]);
        return 'Exact origin filter observed by deterministic fixture.';
      } });
      break;
    case 'partial':
      provider.responses.push(decide(() => 'memocap_read', () => initial.references[0].read.arguments),
        { get text() {
          const receipt = ownEvents().findLast((event) => event.tool === 'memocap_read').receipt;
          assert.equal(receipt.status, 'ok');
          assert.equal(receipt.results[0].completeness, 'full');
          assert.equal(receipt.results[0].memory.content, selected[0].content);
          assert.deepEqual(receipt.returned_ids, [selected[0].id]);
          assert.equal(receipt.results[0].content_hash, initial.references[0].content_hash);
          assert.equal(receipt.record_changed, false);
          assert.equal(initial.references[0].content.includes('TAIL RESTRICTION'), false);
          return JSON.stringify({ decision: 'prohibited', basis: receipt.returned_ids });
        } });
      break;
    case 'denial':
      provider.responses.push(decide(() => 'fixture_destination', () => ({ environment: 'alpha', entry: 'alpha-release' })), finish);
      break;
    default: throw new Error(`Unknown fixture mode ${specification.mode}`);
  }
  const response = await host.api(`/session/${session.id}/message`, {
    model: { providerID: 'wire', modelID: 'wire-model' }, agent: 'build',
    parts: [{ type: 'text', text: specification.query }],
  });
  assert.equal(response.info.error, undefined, JSON.stringify(response.info.error));
  assert.equal(provider.responses.length, 0);
  const observed = ownEvents();
  const actions = observed.filter((event) => event.phase === 'destination_action');
  if (specification.mode === 'source') {
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0].args, destination());
    assert.notEqual(actions[0].args.environment, 'alpha');
    assert.ok(observed.findIndex((event) => event.phase === 'source_read') <
      observed.findIndex((event) => event.phase === 'dispatch'));
    for (const seed of selected) assert.equal(initial.references.find((entry) => entry.id === seed.id).content, seed.content);
  } else assert.equal(actions.length, 0);
  if (specification.mode === 'denial') {
    assert.equal(observed.filter((event) => event.phase === 'dispatch').length, 1);
    const messages = await host.api(`/session/${session.id}/message`);
    const call = messages.flatMap((message) => message.parts).find((part) => part.tool === 'fixture_destination');
    assert.equal(call.state.status, 'error');
    evidence.permission_denial = call.state;
  }
  evidence.cases.push({ ...specification, session: session.id, initial, events: observed,
    scripted_model_policy: true, initial_full_injection: specification.mode !== 'partial' });
}

const cases = Object.freeze([
  { name: 'beta_not_alpha', key: 'environment', query: 'quartzroute beta release', mode: 'source', source: 'environment' },
  { name: 'production_not_alpha', key: 'environment', query: 'quartzroute production release', mode: 'source', source: 'production' },
  { name: 'unknown_verify_first', key: 'unknown', query: 'nebularoute investigate ownership', mode: 'source', source: 'unknown' },
  { name: 'stale_verify_first', key: 'stale', query: 'copperroute release current version', mode: 'source', source: 'stale' },
  { name: 'parallel_conflicting_origins', key: 'conflict', query: 'prismroute beta release', mode: 'source', source: 'conflict' },
  { name: 'explicit_origin_filter', key: 'conflict', query: 'prismroute', mode: 'origin' },
  { name: 'partial_fullread_prohibition', key: 'long', query: 'obsidianroute', mode: 'partial' },
  { name: 'exact_environment_permission_denial', key: 'environment', query: 'quartzroute beta permission check', mode: 'denial' },
]);

module.exports = { runCase, cases, events };
