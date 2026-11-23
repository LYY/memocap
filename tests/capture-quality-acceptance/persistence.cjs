const { hash } = require('./definitions.cjs');
const identity = (row) => JSON.stringify([row?.placement, row?.id]);
const writer = (lane) => ({ capture: 'memocap_remember', maintenance: 'memocap_maintain' })[lane];
const claimedWrite = (event) => event.kind === 'tool.output' && (event.tool === 'memocap_remember' ||
  event.tool === 'memocap_maintain' && !(event.args?.operation === 'use' && event.receipt?.status === 'used') ||
  ['remember', 'organize_maintain'].includes(event.receipt?.operation) || ['inserted', 'updated'].includes(event.receipt?.status));
function sameRecord(left, right) {
  return Boolean(left && right && Number.isInteger(left.id) && typeof left.placement === 'string' &&
    identity(left) === identity(right) && typeof left.content === 'string' &&
    left.content === right.content && left.content_hash === hash(left.content) && left.content_hash === right.content_hash &&
    typeof left.tags_hash === 'string' && left.tags_hash === right.tags_hash);
}
function matchesTool(attempt, event) {
  const envelope = event.receipt; const committed = attempt.commit?.receipt; const dispatch = attempt.dispatch;
  const receipt = attempt.lane === 'maintenance' ? envelope?.untrusted_data?.receipt : envelope;
  const wrapped = attempt.lane === 'capture' && !envelope?.untrusted_data || attempt.lane === 'maintenance' && envelope?.status === 'committed' &&
    envelope.outcome === 'committed' && envelope.operation_id === receipt?.operation_id && envelope.error == null &&
    envelope.untrusted_data.readback != null && attempt.readback?.organization != null &&
    hash(envelope.untrusted_data.readback) === hash(attempt.readback.organization);
  const entry = receipt?.results?.[0];
  const record = entry?.memory && { ...entry.memory, content_hash: hash(entry.memory.content),
    tags_hash: hash(entry.memory.tags ?? ''), completeness: entry.completeness };
  return Boolean(wrapped && dispatch && committed?.operation_id && event.root === dispatch.root && event.user === dispatch.user &&
    event.workflow === dispatch.workflow && event.session === dispatch.session && event.message === dispatch.message &&
    event.tool === writer(attempt.lane) && receipt?.operation === committed.operation && receipt.operation_id === committed.operation_id &&
    receipt.status === committed.status && receipt.error == null && receipt.error_present !== true && receipt.error_code == null &&
    (attempt.lane === 'capture' ? receipt.results?.length === 1 && receipt.returned_ids?.length === 1 &&
      receipt.returned_ids[0] === record?.id && sameRecord(record, committed.records?.[0]) :
      hash(receipt.organization) === hash(attempt.commit.post)));
}
function matchesReadback(checked, record) {
  const full = checked?.records?.[0];
  return Boolean(record && typeof checked?.operation_id === 'string' && checked.operation_id.length &&
    checked.operation === 'read' && checked.status === 'ok' && checked.error_code === null &&
    checked.error_present === false && checked.truncated === false && checked.records?.length === 1 && checked.returned_ids?.length === 1 &&
    checked.returned_ids[0] === record.id && full.completeness === 'full' && identity(full) === identity(record) &&
    full.content_hash === record.content_hash && full.tags_hash === record.tags_hash &&
    sameRecord(full, record));
}
function participants(request) {
  const group = request?.group;
  if (!group) return [];
  switch (group.action) {
    case 'refine': case 'delete': return group.expected ? [group.expected] : [];
    case 'merge': return [group.survivor, ...(group.sources ?? [])].filter(Boolean);
    default: return [];
  }
}
function matchesProposal(attempt, decision) {
  const issued = decision.observations[0]; const observation = issued?.observation; const proposal = observation?.proposal;
  if (!proposal || decision.missing.length || proposal.task?.parentID !== attempt.root || observation.user_id !== attempt.user ||
    issued.root !== attempt.root || issued.user !== attempt.user || issued.workflow !== attempt.lane ||
    proposal.database !== attempt.dispatch?.database) return false;
  const target = proposal.used?.find((used) => used.use_id === proposal.decision.target)?.snapshot;
  const sources = proposal.decision.sources ?? [];
  let group;
  switch (proposal.decision.action) {
    case 'update': group = { action: 'refine', expected: target, content: proposal.decision.content }; break;
    case 'merge': group = { action: 'merge', survivor: target, content: proposal.decision.content,
      sources: sources.map((handle) => proposal.used.find((used) => used.use_id === handle)?.snapshot) }; break;
    case 'delete': group = { action: 'delete', expected: target }; break;
    default: return false;
  }
  const dependencies = proposal.used.filter((used) => ![proposal.decision.target, ...sources].includes(used.use_id)).map((used) => used.snapshot);
  const request = attempt.dispatch.request;
  return request?.mode === 'all' && Object.keys(request).length === 3 && Object.keys(request.group ?? {}).length === Object.keys(group).length &&
    Object.entries(group).every(([field, value]) => hash(request.group?.[field]) === hash(value)) && hash(request.dependencies) === hash(dependencies);
}
function verify(attempt, events) {
  const dispatches = events.filter((row) => row.kind === 'native.dispatch');
  const commits = events.filter((row) => row.kind === 'native.commit');
  const reads = events.filter((row) => row.kind === 'native.readback');
  const dispatch = dispatches[0]; const commit = commits[0]; const read = reads[0];
  const missing = [];
  if (dispatches.length !== 1) missing.push('native.dispatch:expected_one');
  if (commits.length !== 1) missing.push('native.commit:expected_one');
  if (reads.length !== 1) missing.push('native.readback:expected_one');
  const bound = (row) => row.root === dispatch?.root && row.user === dispatch?.user && row.workflow === dispatch?.workflow;
  if (!dispatch?.root || !dispatch?.user || !['capture', 'maintenance'].includes(dispatch?.workflow) ||
    [commit, read].filter(Boolean).some((row) => !bound(row))) missing.push('native.review_binding');
  if (!dispatch?.session || !dispatch?.message || dispatch?.tool !== writer(attempt.lane) || !dispatch?.database || dispatch?.permission !== 'resolved' ||
    !attempt.case_events.some((row) => row.kind === 'permission' && bound(row) && row.session === dispatch.session &&
      row.message === dispatch.message && row.tool === dispatch.tool && row.outcome === 'resolved') ||
    !attempt.case_events.some((row) => row.kind === 'consume' && bound(row) && row.session === dispatch.session && row.message === dispatch.message)) {
    missing.push('native.permission_consume_link');
  }
  const receipt = commit?.receipt;
  if (!receipt?.operation_id || receipt.error_present !== false || receipt.error_code != null) missing.push('native.commit_receipt');
  if (!read?.receipt?.operation_id || read.receipt.operation_id === receipt?.operation_id) missing.push('native.independent_readback_operation');
  for (const event of attempt.case_events.filter((row) => claimedWrite(row) && row.session === dispatch?.session && row.message === dispatch?.message)) {
    if (!matchesTool({ ...attempt, dispatch, commit, readback: read }, event)) missing.push(`tool.output:operation_binding:${event.event_index}`);
  }
  if (attempt.lane === 'capture') {
    if (receipt?.operation !== 'remember' || !['inserted', 'updated'].includes(receipt?.status) || receipt?.records?.length !== 1 ||
      receipt?.returned_ids?.length !== 1 || receipt.returned_ids[0] !== receipt.records[0]?.id ||
      !matchesReadback(read?.receipt, receipt?.records?.[0])) missing.push('native.capture_persistence_join');
  } else {
    const members = participants(dispatch?.request);
    const records = commit?.post?.records ?? []; const removed = commit?.post?.deleted ?? [];
    const post = [...records, ...removed]; const deleted = new Set(removed.map(identity));
    const dependencies = dispatch?.request?.dependencies ?? [];
    const expected = [...members.map((member) => ({ ...member, snapshot: records.find((record) => identity(record) === identity(member)) ?? null })),
      ...dependencies.map((snapshot) => ({ ...snapshot, snapshot }))];
    const observed = read?.organization?.records ?? [];
    if (receipt?.operation !== 'organize_maintain' || receipt?.status !== 'ok' || !members.length ||
      new Set(members.map(identity)).size !== members.length || post.length !== members.length ||
      members.some((member) => post.filter((record) => identity(record) === identity(member)).length !== 1) ||
      new Set(expected.map(identity)).size !== expected.length ||
      !expected.length || observed.length !== expected.length || read?.organization?.database !== dispatch?.database || read?.receipt?.status !== 'ok' ||
      read?.receipt?.error_present !== false || expected.some((snapshot) => {
        const matches = observed.filter((row) => identity(row) === identity(snapshot));
        return matches.length !== 1 || (deleted.has(identity(snapshot)) ? matches[0].snapshot !== null :
          snapshot.snapshot === null || typeof snapshot.snapshot.content !== 'string' || hash(matches[0].snapshot) !== hash(snapshot.snapshot));
      })) missing.push('native.maintenance_persistence_join');
  }
  return { missing, verified: missing.length === 0, dispatch: dispatch ?? null, commit: commit ?? null, readback: read ?? null };
}
module.exports = { verify, participants, identity, matchesProposal, sameRecord, matchesTool, claimedWrite };
