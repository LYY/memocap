use super::{Command, DomainAction, Request};
use crate::{
    activity::{ActivityDetail, RecallActivity, RecallStatus},
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
        Command::Recall {
            query,
            match_mode,
            limit,
            kind,
            max_chars,
            placement,
        } => {
            let mut targets = Vec::new();
            for (index, target) in request.targets.iter().enumerate() {
                let sources =
                    super::sources(connection, &target.repository_id, placement.as_ref())?;
                let placements = sources
                    .iter()
                    .map(|source| source.placement().to_string())
                    .collect::<Vec<_>>();
                receipt.targets[index].placements = placements.clone();
                for placement in placements {
                    if !receipt.searched_placements.contains(&placement) {
                        receipt.searched_placements.push(placement);
                    }
                }
                targets.push(store::RecallTarget {
                    repository: target.repository_id.clone(),
                    sources,
                });
            }
            let options = store::RecallOptions {
                query,
                match_mode: *match_mode,
                kind: kind.as_deref(),
                limit: *limit,
                max_chars: *max_chars,
            };
            let mut returned = store::recall_targets(
                connection,
                &targets,
                store::RecallOptions {
                    limit: usize::try_from(i64::MAX).unwrap_or(usize::MAX),
                    max_chars: None,
                    ..options
                },
            )?;
            receipt.matched_ids = returned.iter().map(|entry| entry.memory.id).collect();
            store::budget_targeted_memories(&mut returned, options.limit, options.max_chars)?;
            receipt.truncated = returned.len() < receipt.matched_ids.len();
            receipt.results = returned
                .into_iter()
                .map(|entry| MemoryResult {
                    source_order: entry
                        .applicability
                        .first()
                        .map_or(0, |app| app.source_order),
                    applicable_repositories: entry
                        .applicability
                        .into_iter()
                        .map(|app| app.repository)
                        .collect(),
                    memory: entry.memory,
                    visibility: "visible".into(),
                    shadowed_by: None,
                })
                .collect();
            receipt.returned_ids = receipt
                .results
                .iter()
                .map(|entry| entry.memory.id)
                .collect();
            receipt.query_terms = query
                .split_whitespace()
                .map(|term| term.replace('"', ""))
                .filter(|term| !term.is_empty())
                .collect();
            let status = if receipt.results.is_empty() {
                receipt.status = Status::Empty;
                RecallStatus::Empty
            } else {
                RecallStatus::Ok
            };
            return Ok(Some(ActivityDetail::Recall(RecallActivity {
                status,
                searched_placements: receipt
                    .searched_placements
                    .iter()
                    .map(|placement| placement.parse())
                    .collect::<Result<_, _>>()?,
                query_terms: receipt.query_terms.clone(),
                matched_ids: receipt.matched_ids.clone(),
                returned_ids: receipt.returned_ids.clone(),
            })));
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
