use super::{request::Request, Outgoing};
use crate::{
    activity::{
        self, ActivityContext, ActivityDetail, ActivityEvent, WriteAction, WriteActivity,
        WriteStatus,
    },
    receipt::Receipt,
    scope::{OperationId, PlacementId, RepositoryId},
    store,
};

pub(super) struct Pending {
    id: OperationId,
    started_at: String,
    repository: RepositoryId,
    action: WriteAction,
    status: WriteStatus,
    placements: Vec<PlacementId>,
    memory_id: Option<i64>,
}

pub(super) fn prepare(connection: &rusqlite::Connection, request: &Request) -> Option<Pending> {
    let receipt = Receipt::new("write");
    let (repository, action, status, placements, id) = match request {
        Request::Remember(input) => (
            &input.repository,
            WriteAction::Remember,
            if input.overwrite_id.is_some() {
                WriteStatus::Updated
            } else {
                WriteStatus::Inserted
            },
            vec![input.placement.clone()],
            receipt.operation_id.parse().ok()?,
        ),
        Request::Forget(input) => (
            &input.repository,
            WriteAction::Forget,
            WriteStatus::Deleted,
            vec![input.placement.clone()],
            receipt.operation_id.parse().ok()?,
        ),
        Request::Transfer(input) => {
            match store::replay_copy_move(connection, &input.request) {
                Ok(Some(_)) | Err(_) => return None,
                Ok(None) => {}
            }
            (
                input.request.repository(),
                match input.request.action() {
                    store::CopyMoveAction::Copy => WriteAction::Copy,
                    store::CopyMoveAction::Move => WriteAction::Move,
                },
                match input.request.action() {
                    store::CopyMoveAction::Copy => WriteStatus::Inserted,
                    store::CopyMoveAction::Move => WriteStatus::Updated,
                },
                vec![input.request.from().clone(), input.request.to().clone()],
                input.request.operation_id().clone(),
            )
        }
        Request::Recall(_)
        | Request::List(_)
        | Request::Domain(_)
        | Request::OperationStatus(_)
        | Request::Status { .. } => return None,
    };
    Some(Pending {
        id,
        started_at: receipt.started_at,
        repository: repository.clone(),
        action,
        status,
        placements,
        memory_id: match request {
            Request::Forget(input) => Some(input.id),
            _ => None,
        },
    })
}

pub(super) fn record(database: &std::path::Path, pending: Pending, outgoing: &Outgoing) {
    let decoded = serde_json::from_str::<serde_json::Value>(&outgoing.body);
    let Ok(decoded) = decoded else {
        return;
    };
    if matches!(pending.action, WriteAction::Forget) && decoded["deleted"] != true {
        return;
    }
    let id = match pending.action {
        WriteAction::Remember => decoded["id"].as_i64(),
        WriteAction::Forget => pending.memory_id,
        WriteAction::Copy | WriteAction::Move => decoded["result"]["memory_id"].as_i64(),
    };
    let event = ActivityEvent {
        operation_id: pending.id,
        related_operation_id: None,
        started_at: pending.started_at,
        elapsed_ms: 0,
        context: ActivityContext {
            repository_ids: vec![pending.repository],
            backend: activity::ActivityBackend::Remote,
            origin: activity::ActivityOrigin::Server,
            ..ActivityContext::default()
        },
        detail: ActivityDetail::Write(WriteActivity {
            action: pending.action,
            status: pending.status,
            memory_ids: id.into_iter().collect(),
            placements: pending.placements,
        }),
        receipt: None,
    };
    if let activity::ActivityStatus::Failed { warning } =
        activity::record_after_commit(database, &event)
    {
        eprintln!("activity warning: {warning}");
    }
}
