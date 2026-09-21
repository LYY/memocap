use anyhow::{bail, Context, Result};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use crate::scope::{OperationId, RepositoryId};

use super::{CopyMoveAction, CopyMoveRequest, CopyMoveResult, StoredResult};

pub fn copy_move(
    connection: &mut rusqlite::Connection,
    request: CopyMoveRequest,
) -> Result<CopyMoveResult> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(result) = replay_result(&transaction, &request)? {
        transaction.commit()?;
        return Ok(result);
    }
    if request.from == request.to {
        bail!("source and destination placements must differ");
    }
    let memory_id = match request.action {
        CopyMoveAction::Copy => copy_memory(&transaction, &request)?,
        CopyMoveAction::Move => move_memory(&transaction, &request)?,
    };
    let created_at = Utc::now().to_rfc3339();
    record_provenance(&transaction, &request, memory_id, &created_at)?;
    let result = CopyMoveResult {
        action: request.action,
        memory_id,
        from: request.from.clone(),
        to: request.to.clone(),
        operation_id: request.operation_id.clone(),
    };
    let result_json = serde_json::to_string(&StoredResult::from(&result))
        .context("serialize copy/move result")?;
    transaction.execute(
        "INSERT INTO operation_ledger (
             operation_id, repository_id, request_fingerprint, mutation, result_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            request.operation_id.as_str(),
            request.repository.as_str(),
            request.request_fingerprint.as_str(),
            request.mutation_json,
            result_json,
            created_at,
        ],
    )?;
    transaction.commit()?;
    Ok(result)
}

pub fn replay_copy_move(
    connection: &rusqlite::Connection,
    request: &CopyMoveRequest,
) -> Result<Option<CopyMoveResult>> {
    replay_result(connection, request)
}

pub fn operation_status(
    connection: &rusqlite::Connection,
    repository: &RepositoryId,
    operation_id: &OperationId,
    request_fingerprint: &str,
) -> Result<Option<CopyMoveResult>> {
    let row = connection
        .query_row(
            "SELECT request_fingerprint, result_json
             FROM operation_ledger
             WHERE operation_id = ?1 AND repository_id = ?2",
            params![operation_id.as_str(), repository.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((stored_fingerprint, result_json)) = row else {
        return Ok(None);
    };
    if stored_fingerprint != request_fingerprint {
        bail!("operation ID conflict: request fingerprint differs");
    }
    serde_json::from_str::<StoredResult>(&result_json)
        .context("operation ledger contains invalid result")?
        .into_result()
        .map(Some)
}

fn replay_result(
    connection: &rusqlite::Connection,
    request: &CopyMoveRequest,
) -> Result<Option<CopyMoveResult>> {
    let row = connection
        .query_row(
            "SELECT request_fingerprint, result_json
             FROM operation_ledger WHERE operation_id = ?1",
            [request.operation_id.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((fingerprint, result_json)) = row else {
        return Ok(None);
    };
    if fingerprint != request.request_fingerprint.as_str() {
        bail!("operation ID conflict: request fingerprint differs");
    }
    serde_json::from_str::<StoredResult>(&result_json)
        .context("operation ledger contains invalid result")?
        .into_result()
        .map(Some)
}

fn copy_memory(transaction: &Transaction<'_>, request: &CopyMoveRequest) -> Result<i64> {
    let (destination_kind, destination_repository, destination_domain) =
        super::super::placement_parts(&request.to);
    let (source_kind, source_repository, source_domain) =
        super::super::placement_parts(&request.from);
    let copied = transaction.execute(
        "INSERT INTO memories (
             content, kind, tags, created_at, updated_at, scope, topic_key,
             placement_kind, repository_id, domain_id
         )
         SELECT content, kind, tags, created_at, updated_at, ?1, topic_key, ?2, ?3, ?4
         FROM memories
         WHERE id = ?5 AND placement_kind = ?6
           AND repository_id IS ?7 AND domain_id IS ?8",
        params![
            super::super::legacy_scope(&request.to),
            destination_kind,
            destination_repository,
            destination_domain,
            request.memory_id,
            source_kind,
            source_repository,
            source_domain,
        ],
    )?;
    if copied != 1 {
        bail!(
            "memory #{} not found in source placement",
            request.memory_id
        );
    }
    Ok(transaction.last_insert_rowid())
}

fn move_memory(transaction: &Transaction<'_>, request: &CopyMoveRequest) -> Result<i64> {
    let (destination_kind, destination_repository, destination_domain) =
        super::super::placement_parts(&request.to);
    let (source_kind, source_repository, source_domain) =
        super::super::placement_parts(&request.from);
    let moved = transaction.execute(
        "UPDATE memories
         SET scope = ?1, placement_kind = ?2, repository_id = ?3, domain_id = ?4
         WHERE id = ?5 AND placement_kind = ?6
           AND repository_id IS ?7 AND domain_id IS ?8",
        params![
            super::super::legacy_scope(&request.to),
            destination_kind,
            destination_repository,
            destination_domain,
            request.memory_id,
            source_kind,
            source_repository,
            source_domain,
        ],
    )?;
    if moved != 1 {
        bail!(
            "memory #{} not found in source placement",
            request.memory_id
        );
    }
    Ok(request.memory_id)
}

fn record_provenance(
    transaction: &Transaction<'_>,
    request: &CopyMoveRequest,
    memory_id: i64,
    created_at: &str,
) -> Result<()> {
    let (source_kind, source_repository, source_domain) =
        super::super::placement_parts(&request.from);
    transaction.execute(
        "INSERT INTO memory_provenance (
             memory_id, source_memory_id, source_placement_kind, source_repository_id,
             source_domain_id, action, operation_id, created_at, applicability_note
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(memory_id) DO NOTHING",
        params![
            memory_id,
            request.memory_id,
            source_kind,
            source_repository,
            source_domain,
            request.action.as_str(),
            request.operation_id.as_str(),
            created_at,
            request.applicability_note.as_deref(),
        ],
    )?;
    Ok(())
}
