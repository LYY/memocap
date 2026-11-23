const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const directory = path.join(root, '.omo/evidence/capture-expansion');
const text = (name) => fs.readFileSync(path.join(directory, name), 'utf8');
const digest = (content) => createHash('sha256').update(content).digest('hex');
const commands = {
  envelope_red: 'node --test tests/capture-sources.test.cjs > .omo/evidence/capture-expansion/source-adapters-red.log 2>&1',
  selection_red: 'node --test tests/capture-sources-selection.test.cjs > .omo/evidence/capture-expansion/source-adapters-selection-red.log 2>&1',
  context_red: "node --test --test-name-pattern='a sibling section' tests/capture-sources-selection.test.cjs > .omo/evidence/capture-expansion/source-adapters-context-red.log 2>&1",
  green: 'set -o pipefail && node --test tests/capture-sources.test.cjs tests/capture-sources-selection.test.cjs tests/capture-evidence.test.cjs tests/capture-admission.test.cjs 2>&1 | tee .omo/evidence/capture-expansion/source-adapters-green.log',
  hosts: 'MEMOCAP_CAPTURE_SOURCE_HOST=1 node --test tests/capture-source-host.integration.test.cjs > .omo/evidence/capture-expansion/source-adapters-host.log 2>&1 &',
  report: 'node tests/capture-source-host/report.cjs',
  replay: 'node tests/capture-source-host/driver.cjs',
};
const logs = Object.fromEntries(['source-adapters-red.log', 'source-adapters-selection-red.log', 'source-adapters-context-red.log',
  'source-adapters-green.log', 'source-adapters-host.log'].map((name) => [name, text(name)]));
assert.match(logs['source-adapters-red.log'], /'skip' !== 'source'/);
assert.match(logs['source-adapters-selection-red.log'], /ℹ fail 4/);
assert.match(logs['source-adapters-context-red.log'], /ℹ fail 1/);
for (const name of ['source-adapters-green.log', 'source-adapters-host.log']) {
  assert.match(logs[name], /ℹ fail 0/);
  assert.match(logs[name], /ℹ skipped 0/);
}
assert.match(logs['source-adapters-green.log'], /ℹ tests 83/);
const replay = JSON.parse(text('source-adapters-replay.json'));
assert.deepEqual(replay.replays.map((entry) => entry.status), ['passed', 'passed']);
const hosts = ['1.19.3', '1.19.5'].map((version) => {
  const evidence = JSON.parse(text(`source-adapters-host-${version}.json`));
  assert.equal(evidence.status, 'observed');
  assert.equal(evidence.host.version, version);
  assert.equal(evidence.sdk, '1.19.3');
  assert.equal(evidence.cleanup.package.active_children, 0);
  assert.equal(evidence.cleanup.package.sandbox_removed, true);
  assert.ok(evidence.cleanup.host_closed && evidence.cleanup.provider_closed && evidence.cleanup.mock_closed);
  assert.equal(evidence.business_requests, 0);
  assert.equal(evidence.adapters.same_request_failure_repair_verification.length, 3);
  const examples = evidence.observations.filter((observation) => ['code.js', 'failed', 'missing', 'mock-accepted', 'mock-verified'].includes(observation.name))
    .map((observation) => ({ name: observation.name, user_id: observation.user_id,
      part: observation.messages.flatMap((message) => message.parts).find((part) => part.type === 'tool') }));
  const sources = Object.values(evidence.adapters.results).filter((result) => result.status === 'source').map((result) => result.source);
  return { identity: evidence.host, sdk: evidence.sdk, artifact: `source-adapters-host-${version}.json`,
    sha256: digest(text(`source-adapters-host-${version}.json`)), cleanup: evidence.cleanup,
    synthetic_raw_field_examples: examples, independently_observed_mock_requests: evidence.mock_requests,
    adapter_selected_units: evidence.adapters.selected_units, adapter_selected_bytes: evidence.adapters.selected_bytes,
    max_retained_source_bytes: Math.max(...sources.map((source) => Buffer.byteLength(JSON.stringify(source)))),
    same_request_failure_repair_verification: evidence.adapters.same_request_failure_repair_verification,
    deleted_file_historical: evidence.adapters.original_deleted_file_still_historical };
});
const files = ['plugin/capture/sources.js', ...['value', 'read', 'profile', 'sections', 'selection'].map((name) => `plugin/capture/sources/${name}.js`),
  'tests/capture-sources.test.cjs', 'tests/capture-sources-selection.test.cjs', 'tests/capture-source-host.integration.test.cjs',
  ...['harness', 'driver', 'synthetic', 'report'].map((name) => `tests/capture-source-host/${name}.cjs`)];
const measurements = files.map((file) => {
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  const pure_loc = content.split('\n').filter((line) => line.trim() && !/^\s*(\/\/|#|--)/.test(line)).length;
  assert.ok(pure_loc <= 250, `${file} exceeds 250 pure LOC`);
  return { file, pure_loc, sha256: digest(content) };
});
const evidence = {
  DoneClaim: 'pure_source_adapter_slice_verified', full_goal_complete: false, runtime_adopted: false,
  commands, red: { envelope_failed: 5, selection_failed: 4, context_failed: 1,
    reason: 'Executable reject-all baselines failed source/selection behavior; actual ancestor-only selection failed sibling condition preservation.' },
  green: { tests: 83, failures: 0, skipped: 0 }, hosts, replay,
  log_hashes: Object.fromEntries(Object.entries(logs).map(([name, content]) => [name, digest(content)])),
  profile_candidate: JSON.parse(text('source-adapters-host-1.19.3.json')).adapters.profile_candidate,
  measurements, lsp: { tool: 'lsp_diagnostics', paths: files, status: 'all_paths_clean_after_final_edits' },
  api: {
    adaptSource: '{host_version,user_id,observed_at,message: SDK Message info,part: SDK Part} -> {status:"source",source}|{status:"skip",reason:{code}}',
    source: '{source_id,user_id,message_id,part_id,call_id?,tool_id?,tool_status?,kind,outcome,authority,host_version,completeness:"full",text,content_hash,pointer,span,context_dependencies:[],invocation?}',
    pointer: '{type,locator,observed_at,content_hash,hash_scope:"observed_text",line_range?}',
    sourceBundles: '(same-process adapted sources, profile?) -> {bundles,bytes?,omitted}; unknown identities and oversized collections omitted',
    bundle: '{bundle_id,source_id,user_id,kind,outcome,completeness:"full_section",observed_at,units,context_dependencies:[codepoint spans]}',
    unit: '{source_id,role:"section"|"context",span:{start,end},text,content_hash,pointer}',
    selectBundles: '(same-process bundles,{user_id,text},profile?) -> {bundles,units,bytes,omitted}',
    quoteSpan: '(same-process source,{start,end}) -> exact text|undefined',
    resolveQuote: '(same-process source,{source_id,content_hash,span,quote}) -> exact quote|undefined',
  },
  selection: 'Lexicographic current-request source ID/locator match, lexical relevance, relevant command-result priority, observation recency, stable bundle identity. No numeric rank weights. Whole bundles and dependencies count toward unit/JSON UTF-8 byte caps.',
  secret_screen: 'Existing observed/value.js clean -> admission secret screen, with one synthetic unit; full raw observation screened before retention caps, normalization, or sectioning. Secret or malformed Unicode causes whole observation omission; no redaction.',
  business_requests: 0, real_memory_db_used: false, extra_model_summary_calls: 0,
  self_review: {
    responsibilities: 'Envelope boundary, exact read framing, source values, finite profile, section context, lexical selection are separate modules; every production module has a direct driver or production adapter caller.',
    boundaries: 'Only actual supported SDK fields become host-owned immutable envelopes; unknown shapes are skipped. No arbitrary JSON escapes into source identity or outcome fields.',
    variants: 'Message role, tool status, and known tool-name dispatch have explicit switches with unknown boundary rejection. Kind comparisons classify structural extraction and selection priority, never business success.',
    escape_hatches: 'No type suppression, casts, fallback SDK, broad production catches, new dependency, secret redaction or provider dispatch.',
    tests: 'Observed RED for reject-all adapter/selector and real missing sibling context; GREEN plus actual two-version payload drivers.',
    parameters: 'Production functions have at most three parameters. Profile is the measured adapter budget domain shared by pooling and selection.',
    destructive_actions: 'Only synthetic fixture files/sandboxes removed. No adapter I/O or production mutations; historical source remains historical after file deletion.',
    logging: 'No production logging/activity additions; only synthetic fixture proof is written under owned ignored evidence paths.',
  },
  qa_history_inspection: 'External SDK session.messages inspects only synthetic fixture sessions; this is NOT bounded capture acquisition proof. Pure adapters have no SDK, file or network reads.',
  limitations: [
    'No evidenceFor, admission, worker, lifecycle, completion, maintenance or provenance/activity integration. Source module is deliberately staged and must be wired or removed before final release.',
    'Unknown tool shapes/names and all incomplete or fragment sources are omitted. No fragment context-completeness claim is made.',
    'Only actual read/builtin bash shapes for 1.19.3 and 1.19.5 are enabled. Bash HTTP output remains command_result, never API/business authority; the independent mock GET is fixture-observed support for later review.',
    'Runbook sections retain ancestry AND every other observed section as dependencies: a pure syntax adapter cannot prove that siblings do not constrain a route. Oversized contextual bundles are omitted; no prefix salvage. This conservative policy can miss short routes in long documents. Reference-style/local-anchor documents fall back to whole-source bundles. Final short route rendering and semantic support review remain future admission work.',
    'Candidate caps are isolated-mechanism measurements, not tuned/frozen quality or holdout gates. No model-quality claim; providers are scripted localhost SSE only.',
    'Tool status stays separate from process exit/report; completed request lifecycle and sticky tool-error semantics are unchanged and must be integrated after acquisition re-verification.',
    'Pointers/hash are historical observed-text locators, not whole-file hash, existence, freshness, or access-permission guarantees.',
  ],
};
fs.writeFileSync(path.join(directory, 'source-adapters.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ DoneClaim: evidence.DoneClaim, tests: evidence.green, hosts: hosts.map((host) => host.identity.version),
  max_pure_loc: Math.max(...measurements.map((file) => file.pure_loc)), runtime_adopted: false }));
