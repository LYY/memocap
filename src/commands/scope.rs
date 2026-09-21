use anyhow::{bail, Result};

use memocap::{
    cli,
    config::{self, Target},
    scope::ResolvedScope,
    store,
};

use crate::ScopeCommand;

use super::{domain, remote::RemoteSession};

pub(crate) fn run(command: ScopeCommand) -> Result<()> {
    match config::resolve_target()? {
        Target::Local { database } => {
            let scope = cli::current_scope()?;
            run_local(&database, &scope, command)
        }
        Target::Remote { address, token } => {
            let session = RemoteSession::current(&address, &token)?;
            run_remote(&session, command)
        }
    }
}

fn run_local(
    database: &std::path::Path,
    scope: &ResolvedScope,
    command: ScopeCommand,
) -> Result<()> {
    match command {
        ScopeCommand::Show => {
            let domains = cli::attached_domains(database, scope.repository())?;
            print!("{}", cli::format_scope_show(scope, &domains));
        }
        ScopeCommand::Copy {
            id,
            from,
            to,
            operation_id,
            note,
        } => {
            let result = cli::copy_move(
                database,
                scope.repository(),
                store::CopyMoveInput {
                    action: store::CopyMoveAction::Copy,
                    memory_id: id,
                    from,
                    to,
                    operation_id,
                    applicability_note: note,
                },
            )?;
            print!("{}", cli::format_copy_move(&result));
        }
        ScopeCommand::Move {
            id,
            from,
            to,
            yes,
            operation_id,
            note,
        } => {
            if !yes {
                bail!("scope move requires --yes");
            }
            let result = cli::copy_move(
                database,
                scope.repository(),
                store::CopyMoveInput {
                    action: store::CopyMoveAction::Move,
                    memory_id: id,
                    from,
                    to,
                    operation_id,
                    applicability_note: note,
                },
            )?;
            print!("{}", cli::format_copy_move(&result));
        }
        ScopeCommand::Domain { command } => domain::run(database, scope.repository(), command)?,
    }
    Ok(())
}

fn run_remote(session: &RemoteSession<'_>, command: ScopeCommand) -> Result<()> {
    match command {
        ScopeCommand::Show => print!("{}", session.scope_show()?),
        ScopeCommand::Copy {
            id,
            from,
            to,
            operation_id,
            note,
        } => {
            let result = session.copy_move(store::CopyMoveInput {
                action: store::CopyMoveAction::Copy,
                memory_id: id,
                from,
                to,
                operation_id,
                applicability_note: note,
            })?;
            print!("{}", cli::format_copy_move(&result));
        }
        ScopeCommand::Move {
            id,
            from,
            to,
            yes,
            operation_id,
            note,
        } => {
            if !yes {
                bail!("scope move requires --yes");
            }
            let result = session.copy_move(store::CopyMoveInput {
                action: store::CopyMoveAction::Move,
                memory_id: id,
                from,
                to,
                operation_id,
                applicability_note: note,
            })?;
            print!("{}", cli::format_copy_move(&result));
        }
        ScopeCommand::Domain { command } => session.domain(command)?,
    }
    Ok(())
}
