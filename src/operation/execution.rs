use super::{history, reads, recovery, repository, writes, Command, Request};
use crate::{
    activity,
    receipt::{Receipt, Status},
    store,
};
use anyhow::{ensure, Result};
use std::{path::Path, time::Instant};

pub fn execute(database: &Path, request: &Request, backend: activity::ActivityBackend) -> Receipt {
    let start = Instant::now();
    let mut receipt = Receipt::new(request.command.name());
    receipt.operation_id = request.operation_id.to_string();
    receipt.targets = request.targets.clone();
    receipt.caller = request.caller.clone();
    if backend == activity::ActivityBackend::Remote {
        receipt.backend = "remote".into();
        receipt.origin = "server".into();
    }
    let origin = if backend == activity::ActivityBackend::Remote {
        crate::repository::Origin::ClientReported
    } else {
        crate::repository::Origin::Local
    };
    for target in &mut receipt.targets {
        if let Some(descriptor) = &mut target.descriptor {
            descriptor.origin = origin;
        }
    }
    if let Err(error) = execute_inner(database, request, &mut receipt) {
        receipt.fail("operation_failed", error.to_string());
        if error.downcast_ref::<store::SimilarMemories>().is_some() {
            receipt.status = Status::Rejected;
        }
    }
    if receipt.succeeded() && !matches!(request.command, Command::ScopeResolve) {
        receipt.load_repository_context(database);
    }
    receipt.finish(start);
    receipt
}

fn execute_inner(database: &Path, request: &Request, receipt: &mut Receipt) -> Result<()> {
    let start = Instant::now();
    request.caller.validate()?;
    for target in &request.targets {
        target.validate()?;
    }
    ensure!(
        !request.targets.is_empty() && request.targets.len() <= 8,
        "one to eight targets are required"
    );
    ensure!(
        request.targets.len() == 1
            || matches!(
                request.command,
                Command::Recall { .. } | Command::ScopeResolve | Command::ActivityRecord { .. }
            ),
        "multiple targets are supported only by recall and activity metadata"
    );
    match &request.command {
        Command::ScopeResolve => return Ok(()),
        Command::Status { read_only: true } => {
            receipt.inspection = Some(crate::inspection::inspect(database, repository(request)?)?);
            return Ok(());
        }
        Command::ActivityList { .. }
        | Command::ActivityShow { .. }
        | Command::ActivityRecord { .. }
        | Command::ActivityPrepare => return history::execute(database, request, receipt),
        Command::OperationStatus { recovery } => {
            return recovery::inspect(database, recovery, receipt)
        }
        _ => {}
    }
    let mut connection = store::open(database)?;
    let detail = match &request.command {
        Command::Remember { .. } | Command::Forget { .. } | Command::Transfer { .. } => {
            writes::execute(&mut connection, request, receipt)?
        }
        Command::Recall { .. }
        | Command::List { .. }
        | Command::ScopeShow
        | Command::Inventory
        | Command::Status { read_only: false }
        | Command::Domain { .. } => reads::execute(&mut connection, request, receipt)?,
        Command::ScopeResolve
        | Command::Status { read_only: true }
        | Command::ActivityList { .. }
        | Command::ActivityShow { .. }
        | Command::ActivityRecord { .. }
        | Command::ActivityPrepare
        | Command::OperationStatus { .. } => unreachable!(),
    };
    receipt.finish(start);
    if detail.is_some()
        && matches!(
            request.command,
            Command::Remember { .. } | Command::Transfer { .. }
        )
    {
        let origin = if receipt.backend == "remote" {
            crate::repository::Origin::ClientReported
        } else {
            crate::repository::Origin::Local
        };
        for target in receipt.targets.clone() {
            if let Err(error) = crate::repository::observe(&connection, &target, origin) {
                receipt.warn(format!(
                    "core committed; repository location unavailable: {error}"
                ));
            }
        }
    }
    if let Some(detail) = detail {
        let event = history::event(request, receipt, detail)?;
        receipt.activity(activity::record_after_commit(database, &event));
    }
    if matches!(request.command, Command::ScopeShow | Command::Status { .. }) {
        receipt.inspection = Some(crate::inspection::inspect_runtime(
            database,
            repository(request)?,
        )?);
    }
    Ok(())
}
