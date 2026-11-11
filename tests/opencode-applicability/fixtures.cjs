const assert = require('node:assert/strict');

const records = Object.freeze([
  { id: 1, key: 'environment', origin: 'A', topic: 'environment',
    content: 'quartzroute: Applies only to alpha. Entry alpha-release. Never use for beta or production. Current source: environment.' },
  { id: 2, key: 'unknown', origin: 'A', topic: 'unknown',
    content: 'nebularoute: Service ownership and environment are unknown. Verify current authoritative source unknown before any operation.' },
  { id: 3, key: 'stale', origin: 'A', topic: 'stale',
    content: 'copperroute: Applies to beta version 1. Entry retired-release. Current source stale reports version 1 was retired; verify current version before execution.' },
  { id: 4, key: 'conflict', origin: 'A', topic: 'shared-conflict',
    content: 'prismroute: For beta version 2 use blue-release. Current source conflict must resolve conflicting instructions.' },
  { id: 5, key: 'conflict', origin: 'universal', topic: 'shared-conflict',
    content: 'prismroute: For beta version 2 use green-release. Current source conflict must resolve conflicting instructions.' },
  { id: 6, key: 'long', origin: 'A', topic: 'long',
    content: `obsidianroute: Operational reference for beta. Current source long. ${'Detailed synthetic context. '.repeat(280)}\nTAIL RESTRICTION: beta execution is prohibited; observation only.` },
]);

const sources = Object.freeze({
  environment: { environment: 'beta', entry: 'beta-current', version: 2 },
  unknown: { environment: 'beta', entry: 'ownership-verified', version: 2 },
  stale: { environment: 'beta', entry: 'replacement-release', version: 2 },
  conflict: { environment: 'beta', entry: 'green-release', version: 2 },
  long: { environment: 'beta', entry: 'observation-only', prohibited: true },
});

function seed(fixture) {
  return records.map((record) => {
    const receipt = fixture.cli(['remember', '--repo', fixture.directories.A,
      ...(record.origin === 'universal' ? ['--universal'] : []), '--topic', record.topic, '--', record.content]);
    assert.equal(receipt.returned_ids.length, 1);
    return { ...record, fixture_id: record.id, id: receipt.returned_ids[0], placement: receipt.searched_placements[0] };
  });
}

module.exports = { records, sources, seed };
