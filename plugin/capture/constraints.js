import { exactPlacement } from '../discovery.js';
import { clean } from './screen.js';
import { freeze, hash, identifier } from './sources/value.js';

export function fullReadConstraint(receipt, requested, caller) {
  if (!receipt || receipt.status !== 'ok' || receipt.operation !== 'read' ||
      !identifier(receipt.operation_id) || !Array.isArray(receipt.results) || receipt.results.length !== 1 || !clean(receipt)) return;
  const entry = receipt.results[0];
  const memory = entry?.memory;
  if (entry?.completeness !== 'full' || !memory || !Number.isSafeInteger(memory.id) || memory.id <= 0 ||
      memory.id !== requested.id || memory.placement !== requested.placement || !exactPlacement(memory.placement) ||
      typeof memory.content !== 'string' || !memory.content.trim() || !memory.content.isWellFormed()) return;
  const content_hash = hash(memory.content);
  const changed = requested.content_hash !== undefined && requested.content_hash !== content_hash;
  if (entry.content_hash !== content_hash || receipt.record_changed !== changed) return;
  return freeze({ root_id: caller.rootID, user_id: caller.userID, message_id: caller.messageID,
    id: memory.id, placement: memory.placement, content_hash, receipt_id: receipt.operation_id, content: memory.content });
}
