import { captureBodyBudget } from './body-budget.js';
import { CaptureStop } from './contract.js';
import { clean } from './screen.js';
import { captureSourceProfile } from './sources/profile.js';
import { byteSize, freeze, hash } from './sources/value.js';
import { adaptSource, selectBundles, sourceBundles } from './sources.js';

function sourceIdentity(source) {
  return { source_id: source.source_id, user_id: source.user_id, message_id: source.message_id,
    part_id: source.part_id, kind: source.kind, content_hash: source.content_hash,
    hash_scope: 'adapted_text_utf8', span: { ...source.span }, completeness: source.completeness };
}

function bundleIdentity(bundle) {
  return { bundle_id: bundle.bundle_id, source_id: bundle.source_id, user_id: bundle.user_id,
    completeness: bundle.completeness, units_total: bundle.units.length,
    units_omitted: Math.max(0, bundle.units.length - captureSourceProfile.max_selected_units),
    units: bundle.units.slice(0, captureSourceProfile.max_selected_units).map((unit) => ({
      role: unit.role, content_hash: unit.content_hash, span: { ...unit.span }, text_sha256: hash(unit.text) })) };
}

function inputProvenance(frames, inventory, packet) {
  const sections = {
    selected_sources: packet.sources.map(sourceIdentity),
    selected_bundles: packet.bundles.map(bundleIdentity),
    constraints: packet.constraints.map(({ id, placement, user_id, message_id, receipt_id, content_hash }) => ({
      id, placement_sha256: hash(placement), user_id, message_id, receipt_id, content_hash })),
    retained_frames: frames.map((frame) => ({ user_id: frame.userID, observed_at: frame.at,
      frame_sha256: hash(JSON.stringify(frame)), messages_total: frame.messages.length,
      message_ids: frame.messages.slice(0, captureSourceProfile.max_sources).map((message) => message.info.id) })),
    adapted_sources: [...inventory.sources.values()].map(sourceIdentity),
    preselection_bundles: inventory.pool.bundles.map(bundleIdentity),
    source_parts: inventory.parts,
  };
  const projection = { version: 1, scope: 'retained_frames', completeness: 'complete',
    upstream_observation: { status: 'unknown', reason: 'retention_and_part_omissions_not_exposed' },
    packet: { sha256: hash(JSON.stringify(packet)), utf8_bytes: byteSize(packet) },
    pool_omitted: { ...inventory.pool.omitted }, selection_omitted: { ...inventory.selection.omitted },
    ...Object.fromEntries(Object.entries(sections).map(([name, entries]) => [name, { total: entries.length, omitted: entries.length, entries: [] }])) };
  let remaining = captureSourceProfile.max_selected_bytes - byteSize(projection);
  for (const [name, entries] of Object.entries(sections)) {
    for (const entry of entries) {
      const size = byteSize(entry) + 1;
      if (size > remaining || projection[name].entries.length >= captureSourceProfile.max_bundles) continue;
      projection[name].entries.push(entry);
      projection[name].omitted -= 1;
      remaining -= size;
      if (entry.units_omitted || entry.messages_total > entry.message_ids?.length) projection.completeness = 'partial';
    }
    if (projection[name].omitted) projection.completeness = 'partial';
  }
  return freeze(projection);
}

export function evidenceContext(frames, turn, version) {
  if (!clean(frames)) throw new CaptureStop('secret');
  const constraints = frames.filter((frame) => frame.userID === turn.userID).flatMap((frame) => frame.constraints ?? []);
  const constraintBytes = constraints.reduce((total, constraint) => total + byteSize(constraint), 0);
  const sources = new Map();
  const parts = [];
  for (const frame of frames) {
    for (const message of frame.messages) {
      for (const part of message.parts) {
        const result = adaptSource({ host_version: version, user_id: frame.userID, observed_at: frame.at,
          message: message.info, part });
        parts.push({ user_id: frame.userID, message_id: message.info.id, part_id: part.id,
          part_sha256: hash(JSON.stringify(part)), adaptation: result.status,
          ...(result.status === 'source' ? { source_id: result.source.source_id } : { reason: result.reason.code }) });
        if (result.status === 'source') {
          if (sources.has(result.source.source_id)) throw new CaptureStop('source_identity');
          sources.set(result.source.source_id, result.source);
        }
      }
    }
  }
  if (sources.size > captureSourceProfile.max_sources || byteSize([...sources.values()]) + constraintBytes > captureSourceProfile.max_input_bytes ||
      constraints.length >= captureSourceProfile.max_selected_units || constraintBytes >= captureSourceProfile.max_selected_bytes) {
    throw new CaptureStop('evidence_budget');
  }
  const request = { user_id: turn.userID, prior_user_ids: frames.filter((frame) => frame.userID !== turn.userID).map((frame) => frame.userID),
    text: frames.at(-1)?.messages[0]?.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '' };
  const pool = sourceBundles([...sources.values()], captureSourceProfile);
  const selection = selectBundles(pool.bundles, request, { ...captureSourceProfile,
    max_input_bytes: captureSourceProfile.max_input_bytes - constraintBytes,
    max_selected_units: captureSourceProfile.max_selected_units - constraints.length,
    max_selected_bytes: captureSourceProfile.max_selected_bytes - constraintBytes });
  if (!selection.bundles.length) throw new CaptureStop('evidence_budget');
  const selected = new Set(selection.bundles.map((bundle) => bundle.source_id));
  const packet = { current_user_id: turn.userID, origin: turn.targets, constraints, bundles: selection.bundles,
    sources: [...sources.values()].filter((source) => selected.has(source.source_id)),
    body_budget: captureBodyBudget(sources, selection.bundles) };
  return { sources: new Map([...sources].filter(([id]) => selected.has(id))), bundles: selection.bundles,
    userID: turn.userID, packet, inputProvenance: inputProvenance(frames, { sources, parts, pool, selection }, packet) };
}
