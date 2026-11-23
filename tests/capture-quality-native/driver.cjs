const { parseArgs } = require('node:util');
const { entry, CanaryBlocked } = require('./entry.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { carrierPlan, supportInputs } = require('./input.cjs');

function preparation() {
  const root = path.resolve(__dirname, '../..');
  const bytes = fs.readFileSync(path.join(root, 'tests/capture-evaluation/tuning.json'));
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'tests/capture-evaluation/native-driver-contract.json'), 'utf8'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== contract.adapter.input_sha256) return { status: 'blocked', reason: 'frozen_tuning_hash_changed' };
  return { status: 'offline_prepared_runtime_blocked', canary: 'not_run', qa7: 'not_run',
    execution: entry().execution, quality_pass: false, runtime_metrics: null, tuning_sha256: sha256,
    holdout: 'not_accessed', input: carrierPlan(JSON.parse(bytes.toString('utf8')), path.join(root, '.native-canary-private-placeholder')),
    support: supportInputs(contract, []),
    implementation_fingerprint: require('./approval.cjs').implementationFingerprint(),
    backend: 'conditional_native_controller',
    blockers: ['user_controlled_model_only_profile', 'native_credential_reference', 'precise_provider_auth_egress',
      'fresh_exact_implementation_approval_v2', 'exact_host_source_and_egress_policy_review',
      'maintenance_original_request_and_executable_independent_check', 'runtime_observation_and_independent_adjudication'],
    cleanup: { resources_created: 0, carrier_files_created: 0, credential_reads: 0 } };
}

async function main(args, dependencies) {
  try {
    const { values } = parseArgs({ args, options: {
      enable: { type: 'boolean' }, 'profile-ref': { type: 'string' }, 'credential-ref': { type: 'string' },
      consent: { type: 'string' }, 'provider-destination': { type: 'string', multiple: true },
      'auth-destination': { type: 'string', multiple: true }, 'auth-none': { type: 'boolean' },
      'existing-capability': { type: 'boolean' }, help: { type: 'boolean' }, prepare: { type: 'boolean' },
      'approval-ref': { type: 'string' }, 'attempt-file': { type: 'string' }, 'private-root': { type: 'string' },
    } });
    if (values.help) return { status: 'not_run', purpose: 'Default-disabled conditional genuine native canary',
      options: ['--prepare (offline; no runtime)', '--enable', '--profile-ref /user-controlled/model-only.json', '--credential-ref opaque-reference-label',
        '--consent quality-native-canary-v1:fresh-bounded-runtime', '--provider-destination https://exact-host/exact-path',
        '--auth-none OR --auth-destination https://exact-host/exact-path', '--existing-capability',
        '--approval-ref /reviewed/fresh-runtime-approval.json', '--attempt-file /persistent/consumed-batch.json',
        '--private-root /approved/new-private-root'],
      note: 'Declarations do not establish permission, profile isolation, credential availability or existing capability.' };
    if (values.prepare && values.enable) return { status: 'blocked', reason: 'ambiguous_mode' };
    if (values.prepare) return preparation();
    if (values['auth-none'] && values['auth-destination']) return { status: 'blocked', reason: 'ambiguous_auth_destinations' };
    const input = { enabled: values.enable, profileRef: values['profile-ref'], credentialRef: values['credential-ref'],
      consent: values.consent, providerDestinations: values['provider-destination'],
      authDestinations: values['auth-none'] ? [] : values['auth-destination'],
      existingCapability: values['existing-capability'], approvalRef: values['approval-ref'],
      attemptFile: values['attempt-file'], privateRoot: values['private-root'] };
    const boundary = entry(input);
    return boundary.status === 'ready' ? await require('./controller.cjs').runNative(input, dependencies) : boundary;
  } catch (error) {
    if (error instanceof CanaryBlocked) return { status: 'blocked', reason: error.code };
    if (error instanceof Error) return { status: 'blocked', reason: 'invalid_arguments_details_withheld' };
    throw error;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === 'blocked' ? 2 : 0;
  });
}
module.exports = { main };
