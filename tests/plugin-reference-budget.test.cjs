const assert = require('node:assert/strict');
const test = require('node:test');
const { receipt, memory } = require('./plugin-fixture.cjs');

for (const escaped of [false, true]) {
  test(`historical locations leave identities and three recalled memories usable (${escaped ? 'escaped' : 'plain'})`, async () => {
    const { referenceBlock } = await import('../plugin/protocol.js');
    const ids = ['a', 'b'].map((letter) => `repository:${letter.repeat(64)}`);
    const fragment = escaped ? '"\\\n\t\u0000' : 'checkout';
    const repository_context = Object.fromEntries(ids.map((id, index) => [id, {
      identity: { display_name: `project-${index}${fragment}`, name_source: 'remote', origin: 'local',
        normalized_remote: `example.com/team/project-${index}`, recorded_at: '2026-10-29T00:00:00Z' },
      locations: Array.from({ length: 100 }, (_, location) => ({
        canonical_path: `/disposable/${location}/${fragment.repeat(10)}`,
        observed_at: '2026-10-29T00:00:00Z', source: 'local',
      })),
    }]));
    const results = Array.from({ length: 4 }, (_, index) => ({ ...memory(index + 1, `rule-${index}: ${fragment.repeat(20)}`),
      memory: { ...memory(index + 1).memory, placement: ids[index % 2], content: `rule-${index}: ${fragment.repeat(20)}` },
      applicable_repositories: ids,
    }));
    const envelope = receipt('recall', { results, returned_ids: [1, 2, 3, 4], repository_context });

    const block = referenceBlock(envelope, {});

    assert.ok(block.text.length <= 6000);
    const payload = JSON.parse(block.text.slice(block.text.indexOf('\n') + 1));
    assert.deepEqual(block.injected_ids, [1, 2, 3]);
    assert.deepEqual(payload.references, results.slice(0, 3).map((entry) => ({
      id: entry.memory.id, placement: entry.memory.placement,
      applicable_repositories: entry.applicable_repositories, content: entry.memory.content,
    })));
    for (const id of ids) {
      assert.deepEqual(payload.repository_context[id].identity, repository_context[id].identity);
      assert.ok(payload.repository_context[id].locations.every((location) =>
        repository_context[id].locations.some((original) => original.canonical_path === location.canonical_path)));
    }
    assert.ok(Object.values(payload.repository_context).some((context) => context.locations.length > 0));
    assert.ok(Object.values(payload.repository_context).reduce((count, context) => count + context.locations.length, 0) < 200);
  });
}
