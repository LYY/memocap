use std::{
    env,
    path::{Path, PathBuf},
};

use anyhow::{bail, Result};

use crate::{
    config,
    config::Target,
    scope::{ResolvedScope, ScopeId},
    store::{self, Memory, RememberOptions, ScopeMigration},
};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopeCounts {
    pub repository: i64,
    pub global: i64,
    pub visible: i64,
}

pub struct ScopeMigrationRequest<'a> {
    pub source: &'a ScopeId,
    pub destination: &'a ScopeId,
    pub migration: ScopeMigration,
    pub dry_run: bool,
}

pub struct LocalStatus<'a> {
    pub scope: &'a ScopeId,
    pub counts: ScopeCounts,
    pub agents_path: &'a Path,
    pub configured: bool,
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

pub fn memory_scope(global: bool) -> Result<ScopeId> {
    if global {
        Ok(ScopeId::global())
    } else {
        Ok(current_scope()?.scope().clone())
    }
}

pub fn remember(
    database: &Path,
    content: &str,
    kind: &str,
    tags: &str,
    force: bool,
    overwrite_id: Option<i64>,
) -> Result<i64> {
    store::remember(
        &store::open(database)?,
        content,
        kind,
        tags,
        "global",
        force,
        overwrite_id,
    )
}

pub fn remember_scoped(
    database: &Path,
    scope: &ScopeId,
    memory: ScopedRemember<'_>,
) -> Result<i64> {
    store::remember_scoped(
        &store::open(database)?,
        scope,
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

pub fn recall(
    database: &Path,
    query: &str,
    limit: usize,
    kind: Option<&str>,
    max_chars: Option<usize>,
) -> Result<Vec<Memory>> {
    store::recall(&store::open(database)?, query, limit, kind, max_chars)
}

pub fn recall_scoped(
    database: &Path,
    scope: &ScopeId,
    query: ScopedRecall<'_>,
) -> Result<Vec<Memory>> {
    store::recall_scoped(
        &store::open(database)?,
        scope,
        query.query,
        query.limit,
        query.kind,
        query.max_chars,
    )
}

pub fn list(database: &Path, limit: usize) -> Result<Vec<Memory>> {
    store::list(&store::open(database)?, limit)
}

pub fn list_scoped(database: &Path, scope: &ScopeId, limit: usize) -> Result<Vec<Memory>> {
    store::list_scoped(&store::open(database)?, scope, limit)
}

pub fn forget(database: &Path, id: i64) -> Result<bool> {
    store::forget(&store::open(database)?, id)
}

pub fn forget_scoped(database: &Path, scope: &ScopeId, id: i64) -> Result<bool> {
    store::forget_scoped(&store::open(database)?, scope, id)
}

pub fn count(database: &Path) -> Result<i64> {
    store::count(&store::open(database)?)
}

pub fn scope_counts(database: &Path, scope: &ScopeId) -> Result<ScopeCounts> {
    let connection = store::open(database)?;
    let repository = store::scope_migration_count(&connection, scope, ScopeMigration::All)?;
    let global =
        store::scope_migration_count(&connection, &ScopeId::global(), ScopeMigration::All)?;
    let visible = store::count_scoped(&connection, scope)?;
    Ok(ScopeCounts {
        repository,
        global,
        visible,
    })
}

pub fn migrate_scope(database: &Path, request: ScopeMigrationRequest<'_>) -> Result<i64> {
    store::migrate_scope(
        &mut store::open(database)?,
        request.source,
        request.destination,
        request.migration,
        request.dry_run,
    )
}

#[must_use]
pub fn format_memories(memories: &[Memory]) -> String {
    if memories.is_empty() {
        return "No local memories found.\n".to_owned();
    }
    let mut out = String::new();
    for memory in memories {
        out.push_str(&format!(
            "#{} [{}] {}\n",
            memory.id, memory.kind, memory.content
        ));
        if !memory.tags.is_empty() {
            out.push_str(&format!("  tags: {}\n", memory.tags));
        }
        out.push_str(&format!(
            "  source: {}\n",
            if memory.scope == "global" {
                "global"
            } else {
                "repository"
            }
        ));
        if !memory.topic_key.is_empty() {
            out.push_str(&format!("  topic: {}\n", memory.topic_key));
        }
        out.push_str(&format!("  time: {}\n", memory.created_at));
    }
    out
}

#[must_use]
pub fn format_scope_show(scope: &ResolvedScope) -> String {
    format!(
        "active_scope: {}\nsource: {}\n",
        scope.scope(),
        scope.source().label()
    )
}

#[must_use]
pub fn format_scope_status(scope: &ScopeId, counts: ScopeCounts) -> String {
    format!(
        "active_scope: {scope}\nrepository_count: {}\nglobal_count: {}\nvisible_count: {}\n",
        counts.repository, counts.global, counts.visible
    )
}

#[must_use]
pub fn format_status(database: &Path, status: LocalStatus<'_>) -> String {
    format!(
        "database: {}\n{}AGENTS.md: {}\nconfigured: {}\n",
        database.display(),
        format_scope_status(status.scope, status.counts),
        status.agents_path.display(),
        if status.configured { "yes" } else { "no" }
    )
}

#[must_use]
pub fn format_remote_status(
    address: &str,
    count: i64,
    agents_path: &Path,
    configured: bool,
) -> String {
    format!(
        "remote: {address}\ncount: {count}\nAGENTS.md: {}\nconfigured: {}\n",
        agents_path.display(),
        if configured { "yes" } else { "no" }
    )
}
