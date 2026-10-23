use super::{Command, Request};
use crate::{
    activity::{ActivityDetail, WriteAction, WriteActivity, WriteStatus},
    receipt::{Receipt, Status},
    scope::PlacementId,
    store,
};
use anyhow::Result;
use rusqlite::Connection;

pub(super) fn execute(
    connection: &mut Connection,
    request: &Request,
    receipt: &mut Receipt,
) -> Result<Option<ActivityDetail>> {
    let repository = super::repository(request)?;
    let (action, status, ids, placements) = match &request.command {
        Command::Remember {
            content,
            kind,
            tags,
            topic,
            force,
            id,
            placement,
        } => {
            let placement = placement
                .clone()
                .unwrap_or_else(|| PlacementId::Repository(repository.clone()));
            super::validate_placement(connection, repository, &placement)?;
            let saved = store::remember_at(
                connection,
                &placement,
                content,
                kind,
                tags,
                store::RememberOptions {
                    topic_key: topic.as_deref(),
                    force: *force,
                    overwrite_id: *id,
                },
            )?;
            let (status, write_status) = if id.is_some() {
                (Status::Updated, WriteStatus::Updated)
            } else {
                (Status::Inserted, WriteStatus::Inserted)
            };
            receipt.status = status;
            (
                WriteAction::Remember,
                write_status,
                vec![saved],
                vec![placement],
            )
        }
        Command::Forget { id, placement } => {
            let placement = placement
                .clone()
                .unwrap_or_else(|| PlacementId::Repository(repository.clone()));
            super::validate_placement(connection, repository, &placement)?;
            receipt.matched_ids = vec![*id];
            if !store::forget_at(connection, &placement, *id)? {
                receipt.status = Status::Empty;
                return Ok(None);
            }
            receipt.status = Status::Deleted;
            (
                WriteAction::Forget,
                WriteStatus::Deleted,
                vec![*id],
                vec![placement],
            )
        }
        Command::Transfer {
            action,
            id,
            from,
            to,
            idempotency_key,
            note,
        } => {
            let transfer = store::CopyMoveRequest::prepare(
                repository.clone(),
                store::CopyMoveInput {
                    action: *action,
                    memory_id: *id,
                    from: from.clone(),
                    to: to.clone(),
                    operation_id: idempotency_key.clone(),
                    applicability_note: note.clone(),
                },
            )?;
            receipt.operation_id = transfer.operation_id().to_string();
            let replayed = store::replay_copy_move(connection, &transfer)?.is_some();
            let committed = store::copy_move(connection, transfer)?;
            receipt.returned_ids = vec![committed.memory_id];
            receipt.searched_placements = vec![from.to_string(), to.to_string()];
            receipt.status = match action {
                store::CopyMoveAction::Copy => Status::Inserted,
                store::CopyMoveAction::Move => Status::Updated,
            };
            if replayed {
                materialize(connection, receipt);
                receipt.activity_status = "not_requested".into();
                receipt.warning =
                    Some("committed transfer replay; activity history may be unavailable".into());
                return Ok(None);
            }
            (
                match action {
                    store::CopyMoveAction::Copy => WriteAction::Copy,
                    store::CopyMoveAction::Move => WriteAction::Move,
                },
                match action {
                    store::CopyMoveAction::Copy => WriteStatus::Inserted,
                    store::CopyMoveAction::Move => WriteStatus::Updated,
                },
                vec![committed.memory_id],
                vec![from.clone(), to.clone()],
            )
        }
        _ => unreachable!(),
    };
    receipt.returned_ids = ids.clone();
    receipt.searched_placements = placements.iter().map(ToString::to_string).collect();
    for target in &mut receipt.targets {
        target.placements = receipt.searched_placements.clone();
    }
    if !matches!(action, WriteAction::Forget) {
        materialize(connection, receipt);
    }
    Ok(Some(ActivityDetail::Write(WriteActivity {
        action,
        status,
        memory_ids: ids,
        placements,
    })))
}

fn materialize(connection: &Connection, receipt: &mut Receipt) {
    let Some(id) = receipt.returned_ids.first() else {
        return;
    };
    match store::memory_by_id(connection, *id) {
        Ok(Some(memory)) => receipt.results.push(crate::receipt::MemoryResult {
            memory,
            source_order: 0,
            visibility: "visible".into(),
            applicable_repositories: receipt
                .targets
                .iter()
                .map(|target| target.repository_id.to_string())
                .collect(),
            shadowed_by: None,
        }),
        Ok(None) => {
            receipt.warning =
                Some("committed memory is no longer available for this receipt".into())
        }
        Err(_) => receipt.warning = Some("core committed; receipt memory could not be read".into()),
    }
}
