use std::{
    env,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};

use crate::{
    config,
    config::Target,
    scope::{DomainId, PlacementId, RepositoryId, ResolvedScope},
    store::{self, InventoryMemory, RememberOptions, VisibleStackStatus},
};

mod domains;
mod transfers;

pub use domains::{
    attach_domain, attached_domains, create_domain, delete_domain, detach_domain, domains,
    format_domains, format_scope_show,
};
pub use transfers::{copy_move, format_copy_move};

pub struct ScopedRemember<'a> {
    pub content: &'a str,
    pub kind: &'a str,
    pub tags: &'a str,
    pub topic: Option<&'a str>,
    pub force: bool,
    pub overwrite_id: Option<i64>,
}

pub struct ScopedRecall<'a> {
    pub query: &'a str,
    pub limit: usize,
    pub kind: Option<&'a str>,
    pub max_chars: Option<usize>,
}

#[derive(Debug, Clone)]
pub enum PlacementSelector {
    Domain(DomainId),
    Universal,
}

pub fn current_scope() -> Result<ResolvedScope> {
    crate::scope::resolve(&env::current_dir()?)
}

pub fn local_database() -> Result<PathBuf> {
    if config::configured_address().is_some() {
        bail!("scope commands are only available in local mode");
    }
    match config::resolve_target()? {
        Target::Local { database } => Ok(database),
        Target::Remote { .. } => bail!("scope commands are only available in local mode"),
    }
}

pub fn placement_selector(
    domain: Option<DomainId>,
    universal: bool,
) -> Result<Option<PlacementSelector>> {
    match (domain, universal) {
        (Some(domain), false) => Ok(Some(PlacementSelector::Domain(domain))),
        (None, true) => Ok(Some(PlacementSelector::Universal)),
        (None, false) => Ok(None),
        (Some(_), true) => bail!("--domain conflicts with --universal"),
    }
}

pub fn remember_placed(
    database: &Path,
    selector: Option<PlacementSelector>,
    memory: ScopedRemember<'_>,
) -> Result<i64> {
    let repository = repository_for_selector(selector.as_ref())?;
    let connection = store::open(database)?;
    let placement = exact_placement(&connection, selector.as_ref(), repository.as_ref())?;
    store::remember_at(
        &connection,
        &placement,
        memory.content,
        memory.kind,
        memory.tags,
        RememberOptions {
            topic_key: memory.topic,
            force: memory.force,
            overwrite_id: memory.overwrite_id,
        },
    )
}

pub fn recall_placed(
    database: &Path,
    selector: Option<PlacementSelector>,
    query: ScopedRecall<'_>,
) -> Result<Vec<InventoryMemory>> {
    let repository = repository_for_selector(selector.as_ref())?;
    let connection = store::open(database)?;
    let sources = read_sources(&connection, selector.as_ref(), repository.as_ref())?;
    store::recall_visible(
        &connection,
        &sources,
        query.query,
        query.limit,
        query.kind,
        query.max_chars,
    )
}

pub fn list_placed(
    database: &Path,
    selector: Option<PlacementSelector>,
    limit: usize,
) -> Result<Vec<InventoryMemory>> {
    let repository = repository_for_selector(selector.as_ref())?;
    list_placed_for(database, selector.as_ref(), repository.as_ref(), limit)
}

pub fn list_visible(database: &Path, repository: &RepositoryId) -> Result<Vec<InventoryMemory>> {
    let connection = store::open(database)?;
    let sources = read_sources(&connection, None, Some(repository))?;
    store::visible_inventory(&connection, &sources)
}

fn list_placed_for(
    database: &Path,
    selector: Option<&PlacementSelector>,
    repository: Option<&RepositoryId>,
    limit: usize,
) -> Result<Vec<InventoryMemory>> {
    let connection = store::open(database)?;
    let sources = read_sources(&connection, selector, repository)?;
    store::list_inventory(&connection, &sources, limit)
}

pub fn visible_status(database: &Path, repository: &RepositoryId) -> Result<VisibleStackStatus> {
    let connection = store::open(database)?;
    let sources = store::visible_sources(&connection, repository)?;
    store::visible_status(&connection, &sources)
}

pub fn forget_placed(
    database: &Path,
    selector: Option<PlacementSelector>,
    id: i64,
) -> Result<bool> {
    let repository = repository_for_selector(selector.as_ref())?;
    let connection = store::open(database)?;
    let placement = exact_placement(&connection, selector.as_ref(), repository.as_ref())?;
    store::forget_at(&connection, &placement, id)
}

#[must_use]
pub fn format_memories(memories: &[InventoryMemory]) -> String {
    if memories.is_empty() {
        return "No local memories found.\n".to_owned();
    }
    let mut out = String::new();
    for entry in memories {
        let memory = &entry.memory;
        out.push_str(&format!(
            "#{} [{}] {}\n",
            memory.id, memory.kind, memory.content
        ));
        if !memory.tags.is_empty() {
            out.push_str(&format!("  tags: {}\n", memory.tags));
        }
        out.push_str(&format!("  placement: {}\n", memory.placement));
        if !memory.topic_key.is_empty() {
            out.push_str(&format!("  topic: {}\n", memory.topic_key));
        }
        out.push_str(&format!("  source_order: {}\n", entry.source_order));
        match &entry.visibility {
            store::Visibility::Visible => {
                out.push_str("  visibility: visible\n  shadowed_by: none\n");
            }
            store::Visibility::Shadowed(cause) => {
                out.push_str(&format!(
                    "  visibility: shadowed\n  shadowed_by: source {} {} topic {}\n",
                    cause.source_order, cause.placement, cause.topic_key
                ));
            }
        }
        out.push_str(&format!("  time: {}\n", memory.created_at));
    }
    out
}

#[must_use]
pub fn format_visible_status(status: &VisibleStackStatus) -> String {
    let mut output = format!("schema_version: {}\n", status.schema_version);
    for count in &status.placements {
        output.push_str(&format!(
            "source {} placement: {} addressable_count: {} effective_count: {}\n",
            count.source_order, count.placement, count.addressable_count, count.effective_count
        ));
    }
    output.push_str(&format!(
        "addressable_total: {}\neffective_total: {}\n",
        status.addressable_total, status.effective_total
    ));
    output
}

fn repository_for_selector(selector: Option<&PlacementSelector>) -> Result<Option<RepositoryId>> {
    match selector {
        Some(PlacementSelector::Universal) => Ok(None),
        Some(PlacementSelector::Domain(_)) | None => {
            Ok(Some(current_scope()?.repository().clone()))
        }
    }
}

fn read_sources(
    connection: &rusqlite::Connection,
    selector: Option<&PlacementSelector>,
    repository: Option<&RepositoryId>,
) -> Result<Vec<store::VisibleSource>> {
    if selector.is_some() {
        return Ok(vec![store::single_visible_source(exact_placement(
            connection, selector, repository,
        )?)]);
    }
    let repository = repository.context("repository placement requires a current repository")?;
    store::visible_sources(connection, repository)
}

fn exact_placement(
    connection: &rusqlite::Connection,
    selector: Option<&PlacementSelector>,
    repository: Option<&RepositoryId>,
) -> Result<PlacementId> {
    match selector {
        Some(PlacementSelector::Universal) => Ok(PlacementId::Universal),
        Some(PlacementSelector::Domain(domain)) => {
            let repository =
                repository.context("domain placement requires a current repository")?;
            validate_domain_placement(connection, repository, domain)?;
            Ok(PlacementId::Domain(domain.clone()))
        }
        None => repository
            .cloned()
            .map(PlacementId::Repository)
            .context("repository placement requires a current repository"),
    }
}

fn validate_domain_placement(
    connection: &rusqlite::Connection,
    repository: &RepositoryId,
    domain: &DomainId,
) -> Result<()> {
    if !store::domains(connection)?.contains(domain) {
        bail!("domain {domain} does not exist");
    }
    if !store::attached_domains(connection, repository)?.contains(domain) {
        bail!("domain {domain} is not attached to this repository");
    }
    Ok(())
}
