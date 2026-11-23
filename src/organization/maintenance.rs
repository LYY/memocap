use super::{apply, Applied, ApplyRequest, Error, Group, Mode, Result};
use crate::{
    activity::{
        self, ActivityContext, ActivityDetail, ActivityEvent, WriteAction, WriteActivity,
        WriteStatus,
    },
    receipt::Receipt,
    scope::PlacementId,
};
use std::{path::Path, time::Instant};

pub fn maintain(database: &Path, request: &ApplyRequest, receipt: &mut Receipt) -> Result<Applied> {
    let start = Instant::now();
    receipt
        .caller
        .validate()
        .map_err(|error| Error::before("invalid_arguments", error))?;
    request
        .validate()
        .map_err(|error| Error::before("invalid_request", error))?;
    match request.mode {
        Mode::All => {}
        Mode::Pending => {
            return Err(Error::before(
                "invalid_request",
                "maintenance requires all mode",
            ))
        }
    }
    let participants = request.group.participants();
    if participants.len() + request.dependencies.len() > 3 {
        return Err(Error::before(
            "invalid_request",
            "maintenance permits at most three participants and dependencies",
        ));
    }
    let (action, status, content) = match &request.group {
        Group::Refine { content, .. } => (
            WriteAction::MaintainUpdate,
            WriteStatus::Updated,
            Some(content),
        ),
        Group::Merge { content, .. } => (
            WriteAction::MaintainMerge,
            WriteStatus::Updated,
            Some(content),
        ),
        Group::Delete { .. } => (WriteAction::MaintainDelete, WriteStatus::Deleted, None),
        Group::Keep { .. } => {
            return Err(Error::before(
                "invalid_request",
                "maintenance does not mutate keep decisions",
            ))
        }
    };
    if content.is_some_and(|body| body.chars().count() > 1200 || body.contains('\0')) {
        return Err(Error::before(
            "invalid_request",
            "maintenance content must be NUL-free and at most 1200 codepoints",
        ));
    }
    let placements: Vec<_> = participants
        .iter()
        .take(1)
        .map(|snapshot| snapshot.placement.clone())
        .collect();
    let mut event = ActivityEvent {
        operation_id: receipt
            .operation_id
            .parse()
            .map_err(|error| Error::before("invalid_arguments", error))?,
        related_operation_id: None,
        started_at: receipt.started_at.clone(),
        elapsed_ms: 0,
        context: ActivityContext {
            repository_ids: placements
                .iter()
                .filter_map(|placement| match placement {
                    PlacementId::Repository(id) => Some(id.clone()),
                    PlacementId::Domain(_) | PlacementId::Universal => None,
                })
                .collect(),
            actor: receipt.caller.actor.clone(),
            session_id: receipt.caller.session_id.clone(),
            message_id: receipt.caller.message_id.clone(),
            ..ActivityContext::default()
        },
        detail: ActivityDetail::Write(WriteActivity {
            action,
            status,
            memory_ids: participants
                .iter()
                .map(|snapshot| i64::from(snapshot.id))
                .collect(),
            placements,
        }),
        receipt: None,
    };
    let applied = apply(database, request)?;
    event.elapsed_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    receipt.activity(activity::record_after_commit(&applied.database, &event));
    Ok(applied)
}
