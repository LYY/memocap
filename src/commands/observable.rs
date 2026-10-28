use crate::{ActivityCommand, Command};
use anyhow::{bail, Result};
use memocap::{
    activity::ActivityBackend,
    cli,
    config::{self, Target},
    operation::{self, Caller, Command as Action, Request},
    receipt::Receipt,
    scope::PlacementId,
};
use std::path::PathBuf;

mod render;
mod scope;

pub(super) fn run(command: Command, options: &crate::Cli) -> Result<()> {
    let caller = options.caller_json.clone().unwrap_or_default();
    let mut failure = Receipt::new("command");
    failure.caller = caller.clone();
    if config::configured_address().is_some() {
        failure.backend = "remote".into();
    }
    let execution = prepare(command, &options.repo, caller).and_then(|request| {
        failure.operation = request.command.name().into();
        failure.targets = request.targets.clone();
        match config::resolve_target()? {
            Target::Local { database } => Ok(operation::execute(
                &database,
                &request,
                ActivityBackend::Local,
            )),
            Target::Remote { address, token } => {
                memocap::remote::execute_receipt(&address, &token, &request)
            }
        }
    });
    let receipt = match execution {
        Ok(receipt) => receipt,
        Err(error) => {
            failure.fail("operation_failed", error.to_string());
            failure
        }
    };
    if options.json {
        println!("{}", serde_json::to_string(&receipt)?);
    } else {
        render::print(&receipt);
    }
    if let Some(warning) = &receipt.warning {
        eprintln!("activity warning: {warning}");
    }
    if !receipt.succeeded() {
        bail!(
            "{}",
            receipt
                .error
                .as_ref()
                .map_or("operation outcome unknown", |error| &error.message)
        );
    }
    Ok(())
}

fn prepare(command: Command, paths: &[PathBuf], caller: Caller) -> Result<Request> {
    if matches!(command, Command::Serve { .. } | Command::Ui) {
        bail!("--json is unsupported for ui and serve");
    }
    if paths.len() > 1
        && !matches!(
            command,
            Command::Recall { .. }
                | Command::Activity {
                    command: ActivityCommand::Record { .. }
                }
        )
    {
        bail!("--repo may be repeated only for recall");
    }
    let resolved = if paths.is_empty() {
        let path = std::env::current_dir()?.canonicalize()?;
        vec![cli::RepositoryTarget {
            scope: if matches!(
                command,
                Command::Status { read_only: true } | Command::Activity { .. }
            ) {
                memocap::scope::resolve_readonly(&path)?
            } else {
                cli::current_scope()?
            },
            path,
        }]
    } else {
        cli::resolve_targets(paths)?
    };
    let targets = resolved
        .into_iter()
        .map(|target| memocap::receipt::Target {
            canonical_path: Some(target.path),
            repository_id: target.scope.repository().clone(),
            identity_source: target.scope.source().label().into(),
            placements: vec![],
        })
        .collect();
    let command = match command {
        Command::Remember {
            content,
            r#type,
            tags,
            force,
            id,
            domain,
            universal,
            topic,
        } => Action::Remember {
            content,
            kind: r#type,
            tags,
            force,
            id,
            topic,
            placement: selected(domain, universal),
        },
        Command::Recall {
            query,
            r#match,
            limit,
            r#type,
            max_chars,
            domain,
            universal,
        } => Action::Recall {
            query,
            match_mode: r#match,
            limit,
            kind: r#type,
            max_chars,
            placement: selected(domain, universal),
        },
        Command::List {
            limit,
            offset,
            placement,
            domain,
            universal,
        } => Action::List {
            exact: placement.is_some(),
            placement: placement.or_else(|| selected(domain, universal)),
            limit,
            offset,
        },
        Command::Forget {
            id,
            domain,
            universal,
        } => Action::Forget {
            id,
            placement: selected(domain, universal),
        },
        Command::Status { read_only } => Action::Status { read_only },
        Command::Activity { command } => match command {
            ActivityCommand::List {
                writes,
                limit,
                offset,
                repository,
                session,
                operation,
            } => Action::ActivityList {
                writes,
                limit,
                offset,
                repository,
                session,
                filter_operation: operation,
            },
            ActivityCommand::Show { id } => Action::ActivityShow { id },
            ActivityCommand::Record { payload } => Action::ActivityRecord {
                event: Box::new(serde_json::from_str(&payload)?),
            },
            ActivityCommand::Prepare => Action::ActivityPrepare,
        },
        Command::Scope { command } => scope::action(command)?,
        Command::Serve { .. } | Command::Ui | Command::Organize { .. } => {
            bail!("command requires dedicated dispatch")
        }
        Command::Operation {
            command: crate::OperationCommand::Status { recovery },
        } => Action::OperationStatus {
            recovery: recovery.to_string(),
        },
    };
    let receipt = Receipt::new(command.name());
    Ok(Request {
        operation_id: receipt.operation_id.parse()?,
        targets,
        command,
        caller,
    })
}

fn selected(domain: Option<memocap::scope::DomainId>, universal: bool) -> Option<PlacementId> {
    domain
        .map(PlacementId::Domain)
        .or_else(|| universal.then_some(PlacementId::Universal))
}
