"use strict";
const assert = require('node:assert/strict');
const test = require('node:test');
const { publicPackage } = require('./capture-published-upgrade/package.cjs');

test('public QA8 refuses a registry package with different integrity than the release receipt before packing', async () => {
  const integrity = byte => `sha512-${Buffer.alloc(64, byte).toString('base64')}`;
  const receipt = { status: 'passed', tag: 'v0.7.1', sha: '1'.repeat(40),
    registry_job: 'https://github.com/LYY/memocap/actions/runs/1/job/2',
    registry: { conclusion: 'success', verify_metadata_integrity_provenance: 'success',
      package: '@lyy-gh/memocap@0.7.1', integrity: integrity(1),
      provenance: 'https://slsa.dev/provenance/v1', transparency_log_index: 1 } };
  const wire = { json: async (binary, args) => {
    assert.equal(binary, 'npm');
    assert.equal(args[0], 'view', 'must reject before packing');
    assert.equal(args[1], '@lyy-gh/memocap@0.7.1');
    return { integrity: integrity(2), tarball: 'https://registry.npmjs.org/@lyy-gh/memocap/-/memocap-0.7.1.tgz' };
  } };
  await assert.rejects(publicPackage(wire, '0.7.1', receipt), /registry integrity differs from release receipt/);
});
