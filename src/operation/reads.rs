use super::{Command, DomainAction, Request};
use crate::{
    activity::ActivityDetail,
    receipt::{MemoryResult, Receipt, Status},
    store,
};
use anyhow::{Context, Result};
use rusqlite::Connection;

pub(super) fn execute(
    connection: &mut Connection,
    request: &Request,
    receipt: &mut Receipt,
) -> Result<Option<ActivityDetail>> {
    let repository = super::repository(request)?;
    match &request.command {
        Command::Recall { .. } => return super::recall::execute(connection, request, receipt),
        Command::Read { id, placement } => {
            receipt.searched_placements = vec![placement.to_string()];
            if let Some(memory) = store::memory_by_id(connection, *id)?
                .filter(|memory| memory.placement == placement.to_string())
            {
                receipt.matched_ids = vec![memory.id];
                receipt.returned_ids = vec![memory.id];
                receipt.results = vec![MemoryResult {
                    memory,
                    source_order: 0,
                    visibility: "visible".into(),
                    applicable_repositories: vec![],
                    applicability: Some(crate::receipt::Applicability::Unknown),
                    shadowed_by: None,
                }];
            } else {
                receipt.status = Status::Empty;
            }
        }
        Command::List {
            placement,
            limit,
            offset,
            exact,
        } => {
            let context = match placement {
                Some(crate::scope::PlacementId::Repository(selected)) if *exact => selected,
                _ => repository,
            };
            let visible = store::visible_sources(connection, context)?;
            let applicable = if placement.as_ref().is_none_or(|placement| {
                visible.iter().any(|source| source.placement() == placement)
            }) {
                vec![context.to_string()]
            } else {
                vec![]
            };
            let inventory = if *exact {
                let selected = placement.as_ref().context("exact placement is required")?;
                receipt.targets[0].placements = vec![selected.to_string()];
                if applicable.is_empty() {
                    crate::inventory::exact(connection, selected)?
                } else {
                    store::visible_inventory(connection, &visible)?
                        .into_iter()
                        .filter(|entry| entry.memory.placement == selected.to_string())
                        .collect()
                }
            } else {
                receipt.targets[0].placements =
                    super::sources(connection, repository, placement.as_ref())?
                        .iter()
                        .map(|source| source.placement().to_string())
                        .collect();
                store::visible_inventory(
                    connection,
                    &super::sources(connection, repository, placement.as_ref())?,
                )?
            };
            receipt.searched_placements = receipt.targets[0].placements.clone();
            receipt.truncated = inventory.len().saturating_sub(*offset) > *limit;
            receipt.results = inventory
                .into_iter()
                .skip(*offset)
                .take(*limit)
                .map(|entry| crate::receipt::MemoryResult::inventory(entry, applicable.clone()))
                .collect();
            receipt.returned_ids = receipt
                .results
                .iter()
                .map(|entry| entry.memory.id)
                .collect();
            if receipt.results.is_empty() {
                receipt.status = Status::Empty;
            }
        }
        Command::Inventory => {
            receipt.inventory = Some(crate::inventory::placements(connection)?);
        }
        Command::ScopeShow | Command::Status { read_only: false } => {
            let sources = store::visible_sources(connection, repository)?;
            receipt.targets[0].placements = sources
                .iter()
                .map(|source| source.placement().to_string())
                .collect();
            receipt.domains = Some(
                store::attached_domains(connection, repository)?
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
            );
        }
        Command::Domain {
            action,
            domain,
            before,
            all,
        } => {
            let domain_required = || domain.as_ref().context("domain is required");
            let changed = match action {
                DomainAction::Create => store::create_domain(connection, domain_required()?)?,
                DomainAction::Attach => store::attach_domain(
                    connection,
                    repository,
                    domain_required()?,
                    before.as_ref(),
                )?,
                DomainAction::Detach => {
                    store::detach_domain(connection, repository, domain_required()?)?
                }
                DomainAction::Delete => store::delete_domain(connection, domain_required()?)?,
                DomainAction::List => {
                    receipt.domains = Some(
                        if *all {
                            store::domains(connection)?
                        } else {
                            store::attached_domains(connection, repository)?
                        }
                        .iter()
                        .map(ToString::to_string)
                        .collect(),
                    );
                    false
                }
            };
            receipt.domain_operation = Some(crate::receipt::DomainOutcome {
                action: *action,
                domain: domain.clone(),
                changed,
            });
            if !changed && !matches!(action, DomainAction::List) {
                receipt.status = Status::Skipped;
            }
        }
        _ => unreachable!(),
    }
    Ok(None)
}
