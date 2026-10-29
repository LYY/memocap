use std::collections::HashMap;

use anyhow::Result;
use rusqlite::Connection;

use crate::scope::RepositoryId;

use super::super::{sqlite_limit, Memory};
use super::{recall_inventory, InventoryMemory, VisibleSource};

#[derive(
    Debug,
    Clone,
    Copy,
    Default,
    PartialEq,
    Eq,
    clap::ValueEnum,
    serde::Serialize,
    serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum MatchMode {
    #[default]
    All,
    Any,
}

#[derive(Debug, Clone, Copy)]
pub struct RecallOptions<'a> {
    pub query: &'a str,
    pub kind: Option<&'a str>,
    pub match_mode: MatchMode,
    pub limit: usize,
    pub max_chars: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct RecallTarget {
    pub repository: RepositoryId,
    pub sources: Vec<VisibleSource>,
}

#[derive(Debug, Clone)]
pub struct TargetRecall {
    pub repository: RepositoryId,
    pub memories: Vec<InventoryMemory>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RecallApplicability {
    pub repository: String,
    pub target_order: usize,
    pub source_order: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TargetedMemory {
    pub memory: Memory,
    pub applicability: Vec<RecallApplicability>,
}

pub fn recall_visible_with_options(
    connection: &Connection,
    sources: &[VisibleSource],
    options: RecallOptions<'_>,
) -> Result<Vec<InventoryMemory>> {
    sqlite_limit(options.limit)?;
    let mut visible = recall_inventory(connection, sources, options)?
        .into_iter()
        .filter(|entry| entry.visibility.is_visible())
        .collect::<Vec<_>>();
    visible.truncate(options.limit);
    Ok(super::take_char_budget(visible, options.max_chars))
}

pub fn recall_targets(
    connection: &Connection,
    targets: &[RecallTarget],
    options: RecallOptions<'_>,
) -> Result<Vec<TargetedMemory>> {
    sqlite_limit(options.limit)?;
    let batches = targets
        .iter()
        .map(|target| {
            Ok(TargetRecall {
                repository: target.repository.clone(),
                memories: recall_inventory(connection, &target.sources, options)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    merge_recalled(batches, options)
}

pub fn merge_recalled(
    batches: Vec<TargetRecall>,
    options: RecallOptions<'_>,
) -> Result<Vec<TargetedMemory>> {
    sqlite_limit(options.limit)?;
    let mut positions = HashMap::new();
    let mut merged: Vec<TargetedMemory> = Vec::new();
    for (target_order, batch) in batches.into_iter().enumerate() {
        for entry in batch
            .memories
            .into_iter()
            .filter(|entry| entry.visibility.is_visible())
        {
            let applicability = RecallApplicability {
                repository: batch.repository.to_string(),
                target_order,
                source_order: entry.source_order,
            };
            let key = (entry.memory.placement.clone(), entry.memory.id);
            if let Some(&position) = positions.get(&key) {
                let shared: &mut TargetedMemory = &mut merged[position];
                if !shared
                    .applicability
                    .iter()
                    .any(|existing| existing.repository == applicability.repository)
                {
                    shared.applicability.push(applicability);
                }
            } else {
                positions.insert(key, merged.len());
                merged.push(TargetedMemory {
                    memory: entry.memory,
                    applicability: vec![applicability],
                });
            }
        }
    }
    budget_targeted_memories(&mut merged, options.limit, options.max_chars)?;
    Ok(merged)
}

pub(crate) fn budget_targeted_memories(
    memories: &mut Vec<TargetedMemory>,
    limit: usize,
    max_chars: Option<usize>,
) -> Result<()> {
    sqlite_limit(limit)?;
    memories.truncate(limit);
    if let Some(max_chars) = max_chars {
        let mut total = 0usize;
        let keep = memories
            .iter()
            .enumerate()
            .take_while(|(index, entry)| {
                total = total.saturating_add(entry.memory.content.chars().count());
                *index == 0 || total <= max_chars
            })
            .count();
        memories.truncate(keep);
    }
    Ok(())
}

pub(crate) fn fts_query(query: &str, mode: MatchMode) -> String {
    let joiner = match mode {
        MatchMode::All => " AND ",
        MatchMode::Any => " OR ",
    };
    query
        .split_whitespace()
        .map(|part| part.replace('"', ""))
        .filter(|part| !part.is_empty())
        .map(|part| format!("\"{part}\""))
        .collect::<Vec<_>>()
        .join(joiner)
}
