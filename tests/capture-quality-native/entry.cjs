const path = require('node:path');

class CanaryBlocked extends Error {
  constructor(code) { super(code); this.name = 'CanaryBlocked'; this.code = code; }
}

function exactDestinations(value) {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (typeof entry !== 'string' || entry.includes('*')) return false;
    try {
      const url = new URL(entry);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        && url.href === entry;
    } catch (error) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  });
}

function prerequisites(input) {
  if (typeof input.profileRef !== 'string' || !path.isAbsolute(input.profileRef)) {
    throw new CanaryBlocked('model_only_profile_required');
  }
  if (typeof input.credentialRef !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.credentialRef)) {
    throw new CanaryBlocked('credential_reference_required');
  }
  if (input.consent !== 'quality-native-canary-v1:fresh-bounded-runtime') {
    throw new CanaryBlocked('fresh_consent_required');
  }
  if (!exactDestinations(input.providerDestinations) || input.providerDestinations.length === 0) {
    throw new CanaryBlocked('precise_destinations_required');
  }
  if (!exactDestinations(input.authDestinations)) throw new CanaryBlocked('auth_destinations_unknown');
  if (input.existingCapability !== true) throw new CanaryBlocked('existing_capability_unconfirmed');
  return { status: 'declared_only', authorization_verified: false };
}

function entry(input = {}) {
  const result = { status: 'not_run', reason: 'explicit_opt_in_required', quality_pass: false,
    execution: { host_starts: 0, sdk_calls: 0, provider_dispatches: 0, native_writes: 0 },
    canary: 'not_run', qa7: 'not_run', runtime_metrics: null };
  if (input.enabled !== true) return result;
  try {
    prerequisites(input);
    if (!input.approvalRef) throw new CanaryBlocked('runtime_approval_required');
    if (!path.isAbsolute(input.approvalRef)) throw new CanaryBlocked('runtime_approval_required');
    if (!input.attemptFile || !path.isAbsolute(input.attemptFile)) throw new CanaryBlocked('persistent_attempt_file_required');
    if (!input.privateRoot || !path.isAbsolute(input.privateRoot)) throw new CanaryBlocked('private_root_required');
    return { ...result, status: 'ready', reason: 'conditional_native_backend' };
  } catch (error) {
    if (error instanceof CanaryBlocked) return { ...result, status: 'blocked', reason: error.code };
    throw error;
  }
}

module.exports = { CanaryBlocked, exactDestinations, prerequisites, entry };
