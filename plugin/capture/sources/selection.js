import { sourceProfile, validProfile } from './profile.js';
import { isBundle } from './sections.js';
import { byteSize, freeze, identifier, secretSafe } from './value.js';

export function selectBundles(bundles, request, profile = sourceProfile) {
  const empty = { bundles: [], units: 0, bytes: 0, omitted: {} };
  if (!validProfile(profile) || !Array.isArray(bundles) || !identifier(request?.user_id) ||
      typeof request.text !== 'string' || !secretSafe(request) || byteSize(request) > profile.max_request_bytes ||
      bundles.length > profile.max_bundles || bundles.reduce((total, bundle) => total + byteSize(bundle), 0) > profile.max_input_bytes) return freeze(empty);
  if (request.prior_user_ids !== undefined && (!Array.isArray(request.prior_user_ids) || request.prior_user_ids.length > 7 ||
      !request.prior_user_ids.every(identifier))) return freeze(empty);
  const eligible = new Set([request.user_id, ...(request.prior_user_ids ?? [])]);
  const normalized = request.text.toLowerCase();
  const anchors = [...new Set([...(normalized.match(/[\p{L}\p{N}_./:-]{3,}/gu) ?? []),
    ...(normalized.match(/[a-z0-9_./:-]{3,}/g) ?? [])])];
  const ranked = bundles.filter((bundle) => isBundle(bundle) && eligible.has(bundle.user_id)).map((bundle) => {
    const text = bundle.units[0].text.toLowerCase();
    const locator = bundle.units[0].pointer.locator;
    const explicit = request.text.includes(bundle.source_id) || request.text.includes(locator);
    const relevant = anchors.some((anchor) => text.includes(anchor));
    return { bundle, explicit, relevant, result: bundle.kind === 'command_result' };
  }).sort((left, right) =>
    Number(right.explicit) - Number(left.explicit) || Number(right.relevant) - Number(left.relevant) ||
    Number(right.result) - Number(left.result) ||
    right.bundle.observed_at - left.bundle.observed_at || left.bundle.bundle_id.localeCompare(right.bundle.bundle_id));
  const selected = [];
  const omitted = { bundle_budget: 0, duplicate: 0 };
  const seen = new Set();
  let units = 0;
  let bytes = 0;
  for (const { bundle } of ranked) {
    if (seen.has(bundle.source_id)) { omitted.duplicate += 1; continue; }
    seen.add(bundle.source_id);
    const size = byteSize(bundle);
    if (units + bundle.units.length > profile.max_selected_units || bytes + size > profile.max_selected_bytes) {
      omitted.bundle_budget += 1;
      continue;
    }
    selected.push(bundle);
    units += bundle.units.length;
    bytes += size;
  }
  return freeze({ bundles: selected, units, bytes, omitted });
}
