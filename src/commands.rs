use anyhow::{bail, Result};

use memocap::{cli, config, config::Target, paths::Paths, remote as remote_api, server, tui};

use crate::{Command, OperationCommand};

mod domain;
mod remote;
mod scope;

pub(crate) fn run(command: Command) -> Result<()> {
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
            let id = match config::resolve_target()? {
                Target::Local { database } => cli::remember_placed(
                    &database,
                    cli::placement_selector(domain, universal)?,
                    cli::ScopedRemember {
                        content: &content,
                        kind: &r#type,
                        tags: &tags,
                        topic: topic.as_deref(),
                        force,
                        overwrite_id: id,
                    },
                )?,
                Target::Remote { address, token } => {
                    remote::RemoteSession::current(&address, &token)?.remember(
                        cli::placement_selector(domain, universal)?,
                        cli::ScopedRemember {
                            content: &content,
                            kind: &r#type,
                            tags: &tags,
                            topic: topic.as_deref(),
                            force,
                            overwrite_id: id,
                        },
                    )?
                }
            };
            println!("saved #{id}");
        }
        Command::Recall {
            query,
            limit,
            r#type,
            max_chars,
            domain,
            universal,
        } => {
            let kind = r#type.as_deref();
            let memories = match config::resolve_target()? {
                Target::Local { database } => cli::recall_placed(
                    &database,
                    cli::placement_selector(domain, universal)?,
                    cli::ScopedRecall {
                        query: &query,
                        limit,
                        kind,
                        max_chars,
                    },
                )?,
                Target::Remote { address, token } => {
                    remote::RemoteSession::current(&address, &token)?.recall(
                        cli::placement_selector(domain, universal)?,
                        cli::ScopedRecall {
                            query: &query,
                            limit,
                            kind,
                            max_chars,
                        },
                    )?
                }
            };
            print!("{}", cli::format_memories(&memories));
        }
        Command::List {
            limit,
            domain,
            universal,
        } => {
            let memories = match config::resolve_target()? {
                Target::Local { database } => cli::list_placed(
                    &database,
                    cli::placement_selector(domain, universal)?,
                    limit,
                )?,
                Target::Remote { address, token } => {
                    remote::RemoteSession::current(&address, &token)?
                        .list(cli::placement_selector(domain, universal)?, limit)?
                }
            };
            print!("{}", cli::format_memories(&memories));
        }
        Command::Forget {
            id,
            domain,
            universal,
        } => {
            let deleted = match config::resolve_target()? {
                Target::Local { database } => {
                    cli::forget_placed(&database, cli::placement_selector(domain, universal)?, id)?
                }
                Target::Remote { address, token } => {
                    remote::RemoteSession::current(&address, &token)?
                        .forget(cli::placement_selector(domain, universal)?, id)?
                }
            };
            println!(
                "{}",
                if deleted {
                    format!("deleted #{id}")
                } else {
                    format!("not found #{id}")
                }
            );
        }
        Command::Scope { command } => scope::run(command)?,
        Command::Operation { command } => run_operation(command)?,
        Command::Status => run_status()?,
        Command::Serve { bind } => {
            let token = config::require_token()?;
            let paths = Paths::discover()?;
            server::serve(&bind, &token, &paths.database)?;
        }
        Command::Ui => tui::run()?,
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

fn run_status() -> Result<()> {
    match config::resolve_target()? {
        Target::Local { database } => {
            let scope = cli::current_scope()?;
            let status = cli::visible_status(&database, scope.repository())?;
            println!(
                "database: {}\nrepository_id: {}\n{}",
                database.display(),
                scope.repository(),
                cli::format_visible_status(&status)
            );
        }
        Target::Remote { address, token } => {
            let scope = cli::current_scope()?;
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
