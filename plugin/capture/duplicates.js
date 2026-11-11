import { repoArgs, validateRead } from '../protocol.js';
import { CaptureStop } from './contract.js';
import { sameKnowledge } from './identity.js';

export async function checkDuplicate(runtime, turn, lifecycle) {
  const caller = { sessionID: turn.parentID, agent: turn.agent };
  await runtime.readPermission.check(caller);
  const receipt = await runtime.recall(turn.parentState, [turn.candidate.fingerprint], turn.targets,
    { signal: turn.controller.signal, discovery: { kind: 'library' } });
  lifecycle.check(turn);
  if (!receipt || !['ok', 'empty'].includes(receipt.status)) throw new CaptureStop('duplicate_lookup_failed');
  for (const hit of receipt.results) {
    await runtime.readPermission.authorize(caller, { operation: 'read', targets: turn.targets,
      discovery: { kind: 'origins', placements: [hit.memory.placement] }, id: hit.memory.id, placement: hit.memory.placement }, true);
    const full = validateRead(await runtime.request(turn.parentState,
      ['read', String(hit.memory.id), '--placement', hit.memory.placement, ...repoArgs(turn.targets)],
      { signal: turn.controller.signal, caller }), hit.memory);
    lifecycle.check(turn);
    if (sameKnowledge(full.results[0].memory, turn.candidate)) throw new CaptureStop('duplicate_body');
  }
  await runtime.readPermission.check(caller);
}
