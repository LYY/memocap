use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use memocap::{
    cli, config, config::Target, paths::Paths, remote as remote_api, server, store, tui,
};

use crate::{Command, OperationCommand};

mod domain;
mod observable;
pub(crate) mod organization;
mod recall;
mod remote;
mod scope;

pub(crate) fn run(command: Command, options: &crate::Cli) -> Result<()> {
    if let Command::Organize { command } = command {
        return organization::run(command, options);
    }
    let paths = &options.repo;
    if options.json
        || options.caller_json.is_some()
        || !matches!(
            &command,
            Command::Serve { .. } | Command::Ui | Command::Operation { .. }
        ) && config::configured_address().is_none()
    {
        return observable::run(command, options);
    }
    if matches!(
        &command,
        Command::Activity { .. }
            | Command::Status { read_only: true }
            | Command::Scope {
                command: crate::ScopeCommand::List { .. }
            }
            | Command::List {
                placement: Some(_),
                ..
            }
            | Command::List { offset: 1.., .. }
            | Command::Recall {
                r#match: store::MatchMode::Any,
                ..
            }
    ) {
        return observable::run(command, options);
    }
    if paths.len() > 1 && !matches!(&command, Command::Recall { .. }) {
        bail!("--repo may be repeated only for recall");
    }
    match command {
        Command::Serve { bind } => {
            require_implicit_target(paths)?;
            server::serve(
                &bind,
                &config::require_token()?,
                &Paths::discover()?.database,
            )
        }
        Command::Ui => {
            require_implicit_target(paths)?;
            tui::run()
        }
        Command::Operation { command } => {
            require_implicit_target(paths)?;
            run_operation(command)
        }
        command => {
            let targets = if paths.is_empty() {
                vec![cli::RepositoryTarget {
                    path: std::env::current_dir()?.canonicalize()?,
                    scope: cli::current_scope()?,
                }]
            } else {
                cli::resolve_targets(paths)?
            };
            run_scoped(command, &targets)
        }
    }
}

fn run_scoped(command: Command, targets: &[cli::RepositoryTarget]) -> Result<()> {
    let scope = &targets
        .first()
        .context("repository target is required")?
        .scope;
    match command {
        Command::Remember {
            content,
            r#type,
            tags,
            force,
            id,
            domain,
            universal,
            topic,
        } => {
            let selector = cli::placement_selector(domain, universal)?;
            let memory = cli::ScopedRemember {
                content: &content,
                kind: &r#type,
                tags: &tags,
                topic: topic.as_deref(),
                force,
                overwrite_id: id,
            };
            let id = match config::resolve_target()? {
                Target::Local { database } => cli::RepositoryContext {
                    repository: scope.repository(),
                    selector: selector.as_ref(),
                }
                .remember(&database, memory)?,
                Target::Remote { address, token } => {
                    remote::RemoteSession::new(&address, &token, scope.clone())
                        .remember(selector, memory)?
                }
            };
            println!("saved #{id}");
        }
        Command::Recall {
            query,
            r#match,
            limit,
            r#type,
            max_chars,
            domain,
            universal,
        } => {
            recall::run(
                targets,
                cli::placement_selector(domain, universal)?,
                store::RecallOptions {
                    query: &query,
                    kind: r#type.as_deref(),
                    match_mode: r#match,
                    limit,
                    max_chars,
                },
            )?;
        }
        Command::List {
            limit,
            domain,
            universal,
            ..
        } => {
            let selector = cli::placement_selector(domain, universal)?;
            let memories = match config::resolve_target()? {
                Target::Local { database } => cli::RepositoryContext {
                    repository: scope.repository(),
                    selector: selector.as_ref(),
                }
                .list(&database, limit)?,
                Target::Remote { address, token } => {
                    remote::RemoteSession::new(&address, &token, scope.clone())
                        .list(selector, limit)?
                }
            };
            print!("{}", cli::format_memories(&memories));
        }
        Command::Forget {
            id,
            domain,
            universal,
        } => {
            let selector = cli::placement_selector(domain, universal)?;
            let deleted = match config::resolve_target()? {
                Target::Local { database } => cli::RepositoryContext {
                    repository: scope.repository(),
                    selector: selector.as_ref(),
                }
                .forget(&database, id)?,
                Target::Remote { address, token } => {
                    remote::RemoteSession::new(&address, &token, scope.clone())
                        .forget(selector, id)?
                }
            };
            println!("{} #{id}", if deleted { "deleted" } else { "not found" });
        }
        Command::Scope { command } => scope::run(command, scope)?,
        Command::Status { .. } => run_status(scope)?,
        Command::Activity { .. } => bail!("activity requires the observable operation API"),
        Command::Serve { .. }
        | Command::Ui
        | Command::Operation { .. }
        | Command::Organize { .. } => {
            bail!("command does not use a repository target");
        }
    }
    Ok(())
}

fn require_implicit_target(paths: &[PathBuf]) -> Result<()> {
    if !paths.is_empty() {
        bail!("--repo is supported by remember, recall, list, forget, scope and status");
    }
    Ok(())
}

fn run_operation(command: OperationCommand) -> Result<()> {
    let Target::Remote { address, token } = config::resolve_target()? else {
        bail!("operation status requires a remote address")
    };
    match command {
        OperationCommand::Status { recovery } => {
            remote::operation_status(&address, &token, &recovery)
        }
    }
}

fn run_status(scope: &memocap::scope::ResolvedScope) -> Result<()> {
    match config::resolve_target()? {
        Target::Local { database } => {
            let status = cli::visible_status(&database, scope.repository())?;
            println!(
                "database: {}\nrepository_id: {}\n{}",
                database.display(),
                scope.repository(),
                cli::format_visible_status(&status)
            );
        }
        Target::Remote { address, token } => {
            let status = remote_api::status(&address, &token, scope.repository())?;
            println!(
                "remote: {address}\nrepository_id: {}\n{}",
                scope.repository(),
                cli::format_visible_status(&status.status)
            );
        }
    }
    Ok(())
}
