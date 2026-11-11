use super::{Command, Request};
use crate::{
    activity::{ActivityDetail, RecallActivity, RecallStatus},
    discovery::Discovery,
    receipt::{Applicability, MemoryResult, Receipt, Status},
    store,
};
use anyhow::{Context, Result};
use rusqlite::Connection;

pub(super) fn execute(
    connection: &Connection,
    request: &Request,
    receipt: &mut Receipt,
) -> Result<Option<ActivityDetail>> {
    let Command::Recall {
        discovery,
        query,
        match_mode,
        limit,
        kind,
        max_chars,
    } = &request.command
    else {
        unreachable!()
    };
    receipt.discovery = Some(discovery.clone());
    receipt.searched_placements = match discovery {
        Discovery::Library => crate::inventory::placements(connection)?
            .into_iter()
            .map(|entry| entry.placement)
            .collect(),
        Discovery::Origins { placements } => placements
            .as_slice()
            .iter()
            .map(ToString::to_string)
            .collect(),
    };
    for target in &mut receipt.targets {
        target.placements.clear();
    }
    let options = store::RecallOptions {
        query,
        match_mode: *match_mode,
        kind: kind.as_deref(),
        limit: *limit,
        max_chars: *max_chars,
    };
    let mut returned = store::recall_discovery(connection, discovery, options)?;
    receipt.matched_ids = returned.iter().map(|entry| entry.memory.id).collect();
    i64::try_from(options.limit).context("memory limit exceeds SQLite range")?;
    returned.truncate(options.limit);
    if let Some(mut remaining) = options.max_chars {
        // Preserve the relevance-ordered prefix of complete authoritative bodies.
        // Stop at the first body that cannot fit, even when it is the first result.
        let keep = returned
            .iter()
            .take_while(
                |entry| match remaining.checked_sub(entry.memory.content.chars().count()) {
                    Some(rest) => {
                        remaining = rest;
                        true
                    }
                    None => false,
                },
            )
            .count();
        returned.truncate(keep);
    }
    receipt.truncated = returned.len() < receipt.matched_ids.len();
    receipt.results = returned
        .into_iter()
        .map(|entry| MemoryResult {
            memory: entry.memory,
            source_order: 0,
            visibility: "visible".into(),
            applicable_repositories: vec![],
            applicability: Some(Applicability::Unknown),
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
    Ok(Some(ActivityDetail::Recall(RecallActivity {
        status,
        searched_placements: receipt
            .searched_placements
            .iter()
            .map(|placement| placement.parse())
            .collect::<Result<_, _>>()?,
        query_terms: receipt.query_terms.clone(),
        matched_ids: receipt.matched_ids.clone(),
        returned_ids: receipt.returned_ids.clone(),
    })))
}
