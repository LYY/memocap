use crate::{DomainCommand, ScopeCommand};
use anyhow::{bail, Result};
use memocap::operation::{Command as Action, DomainAction};

pub(super) fn action(command: ScopeCommand) -> Result<Action> {
    Ok(match command {
        ScopeCommand::Resolve => Action::ScopeResolve,
        ScopeCommand::Show => Action::ScopeShow,
        ScopeCommand::List { all: _ } => Action::Inventory,
        ScopeCommand::Copy {
            id,
            from,
            to,
            operation_id,
            note,
        } => Action::Transfer {
            action: memocap::store::CopyMoveAction::Copy,
            id,
            from,
            to,
            idempotency_key: operation_id,
            note,
        },
        ScopeCommand::Move {
            id,
            from,
            to,
            operation_id,
            note,
            yes,
        } => {
            if !yes {
                bail!("scope move requires --yes");
            }
            Action::Transfer {
                action: memocap::store::CopyMoveAction::Move,
                id,
                from,
                to,
                idempotency_key: operation_id,
                note,
            }
        }
        ScopeCommand::Domain { command } => {
            let (action, domain, before, all) = match command {
                DomainCommand::Create { domain } => {
                    (DomainAction::Create, Some(domain), None, false)
                }
                DomainCommand::Attach { domain, before } => {
                    (DomainAction::Attach, Some(domain), before, false)
                }
                DomainCommand::Detach { domain } => {
                    (DomainAction::Detach, Some(domain), None, false)
                }
                DomainCommand::Delete { domain } => {
                    (DomainAction::Delete, Some(domain), None, false)
                }
                DomainCommand::List { all } => (DomainAction::List, None, None, all),
            };
            Action::Domain {
                action,
                domain,
                before,
                all,
            }
        }
    })
}
