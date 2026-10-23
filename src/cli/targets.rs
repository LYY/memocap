use std::path::{Path, PathBuf};

use anyhow::{bail, Result};

use crate::{
    scope::{self, RepositoryId, ResolvedScope},
    store,
};

use super::{exact_placement, read_sources, PlacementSelector, ScopedRemember};

#[derive(Debug, Clone)]
pub struct RepositoryTarget {
    pub path: PathBuf,
    pub scope: ResolvedScope,
}

pub fn resolve_targets(paths: &[PathBuf]) -> Result<Vec<RepositoryTarget>> {
    if paths.len() > 8 {
        bail!("--repo accepts at most 8 targets");
    }
    let mut targets = Vec::with_capacity(paths.len());
    for path in paths {
        let canonical = path.canonicalize()?;
        if targets
            .iter()
            .any(|target: &RepositoryTarget| target.path == canonical)
        {
            continue;
        }
        let scope = scope::resolve_readonly(&canonical)?;
        targets.push(RepositoryTarget {
            path: canonical,
            scope,
        });
    }
    Ok(targets)
}

pub struct RepositoryContext<'a> {
    pub repository: &'a RepositoryId,
    pub selector: Option<&'a PlacementSelector>,
}

impl RepositoryContext<'_> {
    pub fn remember(&self, database: &Path, memory: ScopedRemember<'_>) -> Result<i64> {
        let connection = store::open(database)?;
        let placement = exact_placement(&connection, self.selector, Some(self.repository))?;
        store::remember_at(
            &connection,
            &placement,
            memory.content,
            memory.kind,
            memory.tags,
            store::RememberOptions {
                topic_key: memory.topic,
                force: memory.force,
                overwrite_id: memory.overwrite_id,
            },
        )
    }

    pub fn list(&self, database: &Path, limit: usize) -> Result<Vec<store::InventoryMemory>> {
        let connection = store::open(database)?;
        let sources = read_sources(&connection, self.selector, Some(self.repository))?;
        store::list_inventory(&connection, &sources, limit)
    }

    pub fn forget(&self, database: &Path, id: i64) -> Result<bool> {
        let connection = store::open(database)?;
        let placement = exact_placement(&connection, self.selector, Some(self.repository))?;
        store::forget_at(&connection, &placement, id)
    }
}

pub struct TargetedRecall<'a> {
    pub repositories: &'a [RepositoryId],
    pub selector: Option<&'a PlacementSelector>,
    pub options: store::RecallOptions<'a>,
}

pub fn recall_targeted(
    database: &Path,
    request: TargetedRecall<'_>,
) -> Result<Vec<store::TargetedMemory>> {
    let connection = store::open(database)?;
    let targets = request
        .repositories
        .iter()
        .map(|repository| {
            Ok(store::RecallTarget {
                repository: repository.clone(),
                sources: read_sources(&connection, request.selector, Some(repository))?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    store::recall_targets(&connection, &targets, request.options)
}

#[must_use]
pub fn format_targeted_memories(memories: &[store::TargetedMemory]) -> String {
    let inventory = memories
        .iter()
        .map(|entry| store::InventoryMemory {
            memory: entry.memory.clone(),
            source_order: entry
                .applicability
                .first()
                .map_or(0, |target| target.source_order),
            visibility: store::Visibility::Visible,
        })
        .collect::<Vec<_>>();
    let mut output = super::format_memories(&inventory);
    for entry in memories {
        let repositories = entry
            .applicability
            .iter()
            .map(|target| target.repository.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        output.push_str(&format!(
            "#{} applies_to: {repositories}\n",
            entry.memory.id
        ));
    }
    output
}
