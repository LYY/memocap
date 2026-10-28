const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { wireProvider, portClosed } = require('./opencode-v1/host.cjs');
const { observe, retain, recordCleanupFailure } = require('./opencode-v1/phases.cjs');

const cases = [
  { name: 'provider cleanup alone fails', provider: true, package: false, original: false,
    status: 'failed', first: 'PROVIDER_CLEANUP_SENTINEL' },
  { name: 'package cleanup alone fails', provider: false, package: true, original: false,
    status: 'failed', first: 'PACKAGE_CLEANUP_SENTINEL' },
  { name: 'both cleanups fail after a passed body', provider: true, package: true, original: false,
    status: 'failed', first: 'PROVIDER_CLEANUP_SENTINEL' },
  { name: 'provider cleanup fails after a blocked body', provider: true, package: false, original: true,
    status: 'blocked', first: 'ORIGINAL_SENTINEL' },
  { name: 'both cleanups fail after a blocked body', provider: true, package: true, original: true,
    status: 'blocked', first: 'ORIGINAL_SENTINEL' },
];

for (const scenario of cases) {
  test(`retained proof preserves failure priority when ${scenario.name}`, async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memocap-cleanup-evidence-'));
    const sandbox = path.join(root, 'sandbox');
    const filename = path.join(root, 'proof.json');
    fs.mkdirSync(sandbox);
    const provider = await wireProvider();
    let providerClosed = false;
    context.after(async () => {
      if (!providerClosed) await provider.close();
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false);
      assert.equal(await portClosed(provider.url), true);
      context.diagnostic(JSON.stringify({ case: scenario.name, temp_removed: true, provider_port_closed: true }));
    });
    const original = new Error('ORIGINAL_SENTINEL');
    const providerError = new Error('PROVIDER_CLEANUP_SENTINEL');
    const packageError = new Error('PACKAGE_CLEANUP_SENTINEL');
    const failures = new Map([original, providerError, packageError].map((error) => [error.message, error]));
    const evidence = { status: 'passed', cleanup: {} };
    let failure;
    if (scenario.original) {
      failure = original;
      evidence.status = 'blocked';
      evidence.blocker = { message: original.message, stack: original.stack };
    }

    await assert.rejects(async () => {
      await observe(evidence, 'provider_cleanup', async () => {
        await provider.close(); providerClosed = true;
        if (scenario.provider) throw providerError;
      }).catch((error) => {
        evidence.cleanup.provider_error = error.message;
        failure = recordCleanupFailure(evidence, failure, error);
      });
      await observe(evidence, 'package_cleanup', async () => {
        fs.rmSync(sandbox, { recursive: true });
        if (scenario.package) throw packageError;
      }).catch((error) => {
        evidence.cleanup.package_error = error.message;
        failure = recordCleanupFailure(evidence, failure, error);
      });
      retain(filename, evidence, [[root, '<isolated-root>']]);
      if (failure) throw failure;
    }, (error) => error === failures.get(scenario.first));

    const proof = JSON.parse(fs.readFileSync(filename));
    context.diagnostic(JSON.stringify({ case: scenario.name, retained_status: proof.status,
      blocker: proof.blocker?.message, cleanup: proof.cleanup, thrown: failure.message }));
    assert.equal(proof.status, scenario.status);
    assert.equal(proof.blocker.message, scenario.first);
    assert.equal(proof.blocker.stack, failures.get(scenario.first).stack);
    assert.equal(fs.existsSync(sandbox), false);
    assert.equal(await portClosed(provider.url), true);
    for (const [name, enabled, error] of [
      ['provider', scenario.provider, providerError], ['package', scenario.package, packageError],
    ]) {
      assert.equal(proof.cleanup[`${name}_error`], enabled ? error.message : undefined);
      assert.equal(proof.phases[`${name}_cleanup`].status, enabled ? 'failed' : 'completed');
      assert.equal(proof.phases[`${name}_cleanup`].error?.message, enabled ? error.message : undefined);
    }
  });
}
