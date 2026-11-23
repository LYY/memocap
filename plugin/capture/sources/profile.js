import { freeze } from './value.js';

export const sourceProfile = freeze({ name: 'source-adapter-candidate-1', max_source_bytes: 32768,
  max_sources: 64, max_input_bytes: 262144, max_selected_units: 12,
  max_selected_bytes: 16384, max_bundle_codepoints: 800, max_bundles: 128, max_request_bytes: 4096 });
export const bundleProfiles = freeze(Object.fromEntries([800, 1600, 3200].map((cap) =>
  [cap, { ...sourceProfile, name: `capture-bundle-${cap}`, max_bundle_codepoints: cap }])));
export const captureSourceProfile = bundleProfiles[3200];

export function validProfile(profile) {
  return Object.entries(sourceProfile).every(([key, value]) => key === 'name' ||
    (Number.isSafeInteger(profile[key]) && profile[key] > 0 && profile[key] <= (key === 'max_bundle_codepoints' ? 3200 : value)));
}
