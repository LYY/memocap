use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::scope::{PlacementId, RepositoryId};

use super::{sqlite_limit, Memory};

mod query;
mod shadow;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleSource {
    placement: PlacementId,
}

impl VisibleSource {
    fn placement(&self) -> &PlacementId {
        &self.placement
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ShadowCause {
    pub source_order: usize,
    pub placement: String,
    pub topic_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Visibility {
    Visible,
    Shadowed(ShadowCause),
}

impl Visibility {
    fn is_visible(&self) -> bool {
        matches!(self, Self::Visible)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct InventoryMemory {
    pub memory: Memory,
    pub source_order: usize,
    pub visibility: Visibility,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PlacementCount {
    pub placement: String,
    pub source_order: usize,
    pub addressable_count: i64,
    pub effective_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct VisibleStackStatus {
    pub schema_version: String,
    pub placements: Vec<PlacementCount>,
    pub addressable_total: i64,
    pub effective_total: i64,
}

pub fn visible_sources(
    connection: &Connection,
    repository: &RepositoryId,
) -> Result<Vec<VisibleSource>> {
    let domains = super::attached_domains(connection, repository)?;
    let mut sources = Vec::with_capacity(domains.len() + 2);
    sources.push(single_visible_source(PlacementId::Repository(
        repository.clone(),
    )));
    sources.extend(
        domains
            .into_iter()
            .map(PlacementId::Domain)
            .map(single_visible_source),
    );
    sources.push(single_visible_source(PlacementId::Universal));
    Ok(sources)
}

#[must_use]
pub fn single_visible_source(placement: PlacementId) -> VisibleSource {
    VisibleSource { placement }
}

pub fn recall_visible(
    connection: &Connection,
    sources: &[VisibleSource],
    query: &str,
    limit: usize,
    kind: Option<&str>,
    max_chars: Option<usize>,
) -> Result<Vec<InventoryMemory>> {
    sqlite_limit(limit)?;
    let mut visible = recall_inventory(connection, sources, query, kind)?
        .into_iter()
        .filter(|entry| entry.visibility.is_visible())
        .collect::<Vec<_>>();
    visible.truncate(limit);
    Ok(take_char_budget(visible, max_chars))
}

pub fn list_inventory(
    connection: &Connection,
    sources: &[VisibleSource],
    limit: usize,
) -> Result<Vec<InventoryMemory>> {
    sqlite_limit(limit)?;
    let mut inventory = visible_inventory(connection, sources)?;
    inventory.truncate(limit);
    Ok(inventory)
}

pub fn visible_inventory(
    connection: &Connection,
    sources: &[VisibleSource],
) -> Result<Vec<InventoryMemory>> {
    list_all_inventory(connection, sources)
}

pub fn visible_status(
    connection: &Connection,
    sources: &[VisibleSource],
) -> Result<VisibleStackStatus> {
    let inventory = visible_inventory(connection, sources)?;
    let mut placements = Vec::with_capacity(sources.len());
    for (source_order, source) in sources.iter().enumerate() {
        let addressable_count = count_entries(&inventory, source_order, false)?;
        let effective_count = count_entries(&inventory, source_order, true)?;
        placements.push(PlacementCount {
            placement: source.placement().to_string(),
            source_order,
            addressable_count,
            effective_count,
        });
    }
    let addressable_total =
        i64::try_from(inventory.len()).context("addressable count exceeds SQLite range")?;
    let effective_total = i64::try_from(
        inventory
            .iter()
            .filter(|entry| entry.visibility.is_visible())
            .count(),
    )
    .context("effective count exceeds SQLite range")?;
    let schema_version = connection.query_row(
        "SELECT major || '.' || minor FROM schema_metadata WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    Ok(VisibleStackStatus {
        schema_version,
        placements,
        addressable_total,
        effective_total,
    })
}

fn recall_inventory(
    connection: &Connection,
    sources: &[VisibleSource],
    query: &str,
    kind: Option<&str>,
) -> Result<Vec<InventoryMemory>> {
    let prepared = super::fts_query(query);
    if prepared.is_empty() {
        return Ok(Vec::new());
    }
    let kind = kind.map(str::trim).filter(|value| !value.is_empty());
    let topics = shadow::shadow_topics(connection, sources)?;
    let mut inventory = Vec::new();
    for (source_order, source) in sources.iter().enumerate() {
        for memory in query::recalled_memories(connection, source.placement(), &prepared, kind)? {
            inventory.push(InventoryMemory {
                visibility: shadow::visibility_for(source, &memory.topic_key, &topics),
                memory,
                source_order,
            });
        }
    }
    Ok(inventory)
}

fn list_all_inventory(
    connection: &Connection,
    sources: &[VisibleSource],
) -> Result<Vec<InventoryMemory>> {
    let topics = shadow::shadow_topics(connection, sources)?;
    let mut inventory = Vec::new();
    for (source_order, source) in sources.iter().enumerate() {
        for memory in query::listed_memories(connection, source.placement())? {
            inventory.push(InventoryMemory {
                visibility: shadow::visibility_for(source, &memory.topic_key, &topics),
                memory,
                source_order,
            });
        }
    }
    Ok(inventory)
}

fn count_entries(
    inventory: &[InventoryMemory],
    source_order: usize,
    effective_only: bool,
) -> Result<i64> {
    let count = inventory
        .iter()
        .filter(|entry| entry.source_order == source_order)
        .filter(|entry| !effective_only || entry.visibility.is_visible())
        .count();
    i64::try_from(count).context("visible stack count exceeds SQLite range")
}

fn take_char_budget(
    memories: Vec<InventoryMemory>,
    max_chars: Option<usize>,
) -> Vec<InventoryMemory> {
    let Some(max_chars) = max_chars else {
        return memories;
    };
    let mut total = 0usize;
    let mut output = Vec::new();
    for memory in memories {
        let length = memory.memory.content.chars().count();
        if !output.is_empty() && total.saturating_add(length) > max_chars {
            break;
        }
        total = total.saturating_add(length);
        output.push(memory);
    }
    output
}
