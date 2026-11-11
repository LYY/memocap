const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { repo, prepare, wireProvider, startHost, portClosed } = require('./opencode-v1/host.cjs');
const { retain } = require('./opencode-v1/phases.cjs');
const { mergeHostConfig } = require('./packaged-runtime.cjs');
const { seed, records, sources } = require('./opencode-applicability/fixtures.cjs');
const { runCase, cases } = require('./opencode-applicability/scenarios.cjs');

test('synthetic applicability fixtures retain conflicts and a prohibition beyond the injection budget', () => {
  assert.equal(new Set(records.map((record) => record.id)).size, records.length);
  const conflicts = records.filter((record) => record.key === 'conflict');
  assert.equal(conflicts.length, 2);
  assert.equal(conflicts[0].topic, conflicts[1].topic);
  assert.notEqual(conflicts[0].origin, conflicts[1].origin);
  const long = records.find((record) => record.key === 'long').content;
  assert.ok(long.indexOf('TAIL RESTRICTION') > 6000);
});

test('actual packaged OpenCode applicability operations with deterministic localhost decisions',
  { skip: process.env.MEMOCAP_APPLICABILITY_E2E !== '1', timeout: 600000 }, async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memocap-applicability-'));
    const evidence = { status: 'running', commands: [], assertions: [], cleanup: {}, cases: [], claims: {
      deterministic_fixture_policy: true, real_ai_quality: false, universal_safety: false,
      frozen_v1: { score: '7/12', no_answer_and_forbidden_exposure: 'remain_reported', changed: false },
      operational_fullread_counts_as_initial_full_injection: false,
      paid_provider_requests: 0, business_network_requests: 0,
    } };
    let fixture;
    let provider;
    let host;
    try {
      fixture = await prepare(root, evidence);
      const seeds = seed(fixture);
      evidence.native_whole_record_budget_control = fixture.cli(['recall', 'obsidianroute', '--library', '--max-chars', '6000']);
      assert.deepEqual(evidence.native_whole_record_budget_control.returned_ids, []);
      provider = await wireProvider({ emptyCaptureExtraction: true });
      const journal = path.join(root, 'actions.jsonl');
      const sourceFile = path.join(root, 'authoritative-sources.json');
      fs.writeFileSync(journal, '');
      fs.writeFileSync(sourceFile, JSON.stringify({ ...sources,
        production: { environment: 'production', entry: 'production-current', version: 2 } }));
      const pluginRoot = path.join(fixture.env.XDG_CACHE_HOME, 'opencode/packages',
        `@lyy-gh/memocap@${fixture.version}`, 'node_modules');
      const sdkRoot = path.join(pluginRoot, '@opencode-ai/plugin');
      const sdk = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json')));
      const installed = require('jsonc-parser').parse(fs.readFileSync(fixture.config, 'utf8'));
      mergeHostConfig(fixture.config, { plugin: [[pathToFileURL(path.join(__dirname,
        'opencode-applicability/observer.mjs')).href, {
        plugin: pathToFileURL(path.join(pluginRoot, '@lyy-gh/memocap/plugin/cli.js')).href,
        sdk: pathToFileURL(path.join(sdkRoot, sdk.exports['.'].import)).href,
        policy: installed.plugin[0][1], journal, sources: sourceFile,
      }]] });
      host = await startHost(fixture, provider, evidence);
      for (const specification of cases) await runCase({ host, provider, journal, seeds, evidence }, specification);
      assert.deepEqual(provider.errors, []);
      evidence.model_dispatches = provider.requests.map((request) => request.body);
      evidence.status = 'passed';
    } catch (error) {
      evidence.status = error.message.includes('build the current native version') ? 'not_run' : 'failed';
      evidence.error = error.stack;
      throw error;
    } finally {
      try {
        if (host) await host.close();
        if (provider) await provider.close();
        evidence.cleanup.host_port_closed = host ? await portClosed(evidence.host.url) : true;
        evidence.cleanup.provider_port_closed = provider ? await portClosed(provider.url) : true;
        if (fixture) evidence.cleanup.package = await fixture.cleanup();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        evidence.cleanup.action_sandbox_removed = !fs.existsSync(root);
        retain(process.env.MEMOCAP_APPLICABILITY_EVIDENCE || path.join(repo,
          '.omo/evidence/memory-recall/opencode-applicability.json'), evidence,
        [[root, '<action-sandbox>'], ...(fixture ? [[fixture.packaged.root, '<package-sandbox>']] : [])]);
        context.diagnostic(JSON.stringify({ status: evidence.status, cases: evidence.cases.length, cleanup: evidence.cleanup }));
      }
    }
  });
