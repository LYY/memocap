use super::{Command, Request};
use crate::{
    activity::{
        self, ActivityContext, ActivityDetail, ActivityEvent, ActivityStore, ReceiptDetails,
    },
    receipt::{Receipt, Status},
};
use anyhow::{ensure, Result};
use std::path::Path;

pub(super) fn event(
    request: &Request,
    receipt: &Receipt,
    detail: ActivityDetail,
) -> Result<ActivityEvent> {
    let (result_limit, max_chars) = match &request.command {
        Command::Recall {
            limit, max_chars, ..
        } => (
            u32::try_from(*limit).ok(),
            max_chars.and_then(|budget| u32::try_from(budget).ok()),
        ),
        _ => (None, None),
    };
    Ok(ActivityEvent {
        operation_id: receipt.operation_id.parse()?,
        related_operation_id: None,
        started_at: receipt.started_at.clone(),
        elapsed_ms: receipt.elapsed_ms,
        context: ActivityContext {
            repository_ids: request
                .targets
                .iter()
                .map(|target| target.repository_id.clone())
                .collect(),
            actor: request.caller.actor.clone(),
            session_id: request.caller.session_id.clone(),
            message_id: request.caller.message_id.clone(),
            backend: if receipt.backend == "remote" {
                activity::ActivityBackend::Remote
            } else {
                activity::ActivityBackend::Local
            },
            origin: if receipt.origin == "server" {
                activity::ActivityOrigin::Server
            } else {
                activity::ActivityOrigin::Cli
            },
        },
        detail,
        receipt: Some(ReceiptDetails {
            truncated: receipt.truncated,
            result_limit,
            max_chars,
            ..ReceiptDetails::default()
        }),
    })
}

pub(super) fn execute(database: &Path, request: &Request, receipt: &mut Receipt) -> Result<()> {
    match &request.command {
        Command::ActivityPrepare => {
            ensure!(
                receipt.backend == "local",
                "remote preparation requires the server administrator"
            );
            ActivityStore::prepare(database)?;
        }
        Command::ActivityRecord { event } => {
            ensure!(
                !matches!(event.detail, ActivityDetail::Write(_)),
                "write events require an actual core commit"
            );
            ensure!(
                event.context.actor == "plugin"
                    && event.context.origin == activity::ActivityOrigin::Plugin,
                "metadata sink requires plugin actor and origin"
            );
            let mut event = *event.clone();
            event.context.backend = if receipt.backend == "remote" {
                activity::ActivityBackend::Remote
            } else {
                activity::ActivityBackend::Local
            };
            receipt.operation_id = event.operation_id.to_string();
            receipt.origin = "plugin".into();
            receipt.activity(activity::record_after_commit(database, &event));
            if receipt.activity_status == "failed" {
                receipt.fail(
                    "activity_failed",
                    receipt.warning.clone().unwrap_or_default(),
                );
            }
        }
        Command::ActivityList {
            writes,
            limit,
            offset,
            repository,
            session,
            filter_operation,
        } => {
            let history = ActivityStore::open_readonly(database)?;
            receipt.events = Some(
                history
                    .list(&activity::ActivityQuery {
                        writes_only: *writes,
                        limit: *limit,
                        offset: *offset,
                        repository: repository.as_ref(),
                        session_id: session.as_deref(),
                        operation_id: filter_operation.as_ref(),
                    })?
                    .into_iter()
                    .map(Into::into)
                    .collect(),
            );
        }
        Command::ActivityShow { id } => {
            let history = ActivityStore::open_readonly(database)?;
            let events = history.show(id)?;
            receipt.history_status = Some(
                if events.is_empty() {
                    "not_found_or_expired"
                } else {
                    "retained"
                }
                .into(),
            );
            receipt.events = Some(events.into_iter().map(Into::into).collect());
        }
        _ => unreachable!(),
    }
    if receipt.events.as_ref().is_some_and(Vec::is_empty) {
        receipt.status = Status::Empty;
    }
    Ok(())
}

pub(super) fn hints(database: &Path, request: &Request, receipt: &mut Receipt) {
    let hints = || -> Result<()> {
        if let Some(inventory) = &mut receipt.inventory {
            if let Ok(history) = ActivityStore::open_readonly(database) {
                for entry in inventory {
                    if let Ok(repository) = entry.placement.parse() {
                        entry.repository_hint = history.repository_hint(&repository)?;
                    }
                }
            }
        }
        let explicit = request
            .targets
            .iter()
            .filter(|target| target.canonical_path.is_some());
        for target in explicit {
            let mut history = ActivityStore::open(database)?;
            let path = target.canonical_path.clone();
            history.update_repository_hint(&activity::RepositoryHint {
                repository_id: target.repository_id.clone(),
                display_name: path
                    .as_ref()
                    .and_then(|p| p.file_name())
                    .map(|name| name.to_string_lossy().into_owned()),
                canonical_path: path,
                identity_source: Some(target.identity_source.clone()),
                last_seen: chrono::Utc::now().to_rfc3339(),
            })?;
        }
        Ok(())
    }();
    if let Err(error) = hints {
        if receipt.warning.is_none() {
            receipt.warning = Some(error.to_string());
        }
    }
}
