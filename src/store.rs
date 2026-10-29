use std::{path::Path, time::Duration};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};

use crate::scope::{PlacementId, RepositoryId, ScopeId};

mod domains;
mod inspection;
pub mod schema;
mod transfers;
mod visible;

pub use domains::{
    attach_domain, attached_domains, create_domain, delete_domain, detach_domain, domains,
};
pub use inspection::{memory_by_id, open_readonly, open_strict_readonly};
pub use transfers::{
    copy_move, copy_move_observed, operation_status, replay_copy_move, CopyMoveAction,
    CopyMoveInput, CopyMoveRequest, CopyMoveResult,
};
pub(crate) use visible::budget_targeted_memories;
pub use visible::{
    list_inventory, merge_recalled, recall_targets, recall_visible, recall_visible_with_options,
    single_visible_source, visible_inventory, visible_sources, visible_status, InventoryMemory,
    MatchMode, PlacementCount, RecallApplicability, RecallOptions, RecallTarget, ShadowCause,
    TargetRecall, TargetedMemory, Visibility, VisibleSource, VisibleStackStatus,
};

pub const DEFAULT_RECALL_LIMIT: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaLifecycle {
    Created,
    Opened,
    Upgraded,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Memory {
    pub id: i64,
    pub content: String,
    pub kind: String,
    pub tags: String,
    pub created_at: String,
    pub updated_at: String,
    pub scope: String,
    pub topic_key: String,
    pub placement: String,
}

#[derive(Debug)]
pub struct SimilarMemories {
    pub candidates: Vec<Memory>,
}

pub struct RememberOptions<'a> {
    pub topic_key: Option<&'a str>,
    pub force: bool,
    pub overwrite_id: Option<i64>,
}

impl std::fmt::Display for SimilarMemories {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "similar memories found; pass --force to insert anyway")?;
        for memory in &self.candidates {
            writeln!(f, "#{} [{}] {}", memory.id, memory.kind, memory.content)?;
        }
        Ok(())
    }
}

impl std::error::Error for SimilarMemories {}

pub fn open(path: &Path) -> Result<Connection> {
    let (connection, _) = open_with_lifecycle(path)?;
    Ok(connection)
}

pub fn open_with_lifecycle(path: &Path) -> Result<(Connection, SchemaLifecycle)> {
    schema::open(path, Duration::from_secs(5))
}

pub fn remember(
    connection: &Connection,
    content: &str,
    kind: &str,
    tags: &str,
    scope: &str,
    force: bool,
    overwrite_id: Option<i64>,
) -> Result<i64> {
    let scope = scope
        .parse::<ScopeId>()
        .map_err(|_| anyhow::anyhow!("invalid memory scope"))?;
    remember_scoped(
        connection,
        &scope,
        content,
        kind,
        tags,
        RememberOptions {
            topic_key: None,
            force,
            overwrite_id,
        },
    )
}

pub fn remember_scoped(
    connection: &Connection,
    scope: &ScopeId,
    content: &str,
    kind: &str,
    tags: &str,
    options: RememberOptions<'_>,
) -> Result<i64> {
    let placement = placement_from_scope(scope)?;
    remember_at(connection, &placement, content, kind, tags, options)
}

pub fn remember_at(
    connection: &Connection,
    placement: &PlacementId,
    content: &str,
    kind: &str,
    tags: &str,
    options: RememberOptions<'_>,
) -> Result<i64> {
    if !connection.is_autocommit() {
        return remember_in_transaction(connection, placement, content, kind, tags, options);
    }
    remember_with_descriptor(connection, placement, content, kind, tags, options, None)
}

pub fn remember_with_descriptor(
    connection: &Connection,
    placement: &PlacementId,
    content: &str,
    kind: &str,
    tags: &str,
    options: RememberOptions<'_>,
    descriptor: Option<&crate::repository::Descriptor>,
) -> Result<i64> {
    let transaction =
        rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
    let id = remember_in_transaction(&transaction, placement, content, kind, tags, options)?;
    if let (PlacementId::Repository(repository), Some(descriptor)) = (placement, descriptor) {
        crate::repository::record_identity(&transaction, repository, descriptor)?;
    }
    transaction.commit()?;
    Ok(id)
}

fn remember_in_transaction(
    connection: &Connection,
    placement: &PlacementId,
    content: &str,
    kind: &str,
    tags: &str,
    options: RememberOptions<'_>,
) -> Result<i64> {
    let content = content.trim();
    if content.is_empty() {
        anyhow::bail!("memory content is empty");
    }
    let now: DateTime<Utc> = Utc::now();
    let stamp = now.to_rfc3339();
    let kind = {
        let k = kind.trim();
        if k.is_empty() {
            "context"
        } else {
            k
        }
    };
    let tags = tags.trim();
    let topic_key = normalize_topic_key(options.topic_key);
    let (placement_kind, repository_id, domain_id) = placement_parts(placement);
    let scope = legacy_scope(placement);
    if let Some(id) = options.overwrite_id {
        let updated = connection.execute(
            "UPDATE memories
             SET content = ?1, kind = ?2, tags = ?3, topic_key = COALESCE(?4, topic_key), updated_at = ?5
             WHERE id = ?6
               AND placement_kind = ?7
               AND repository_id IS ?8
               AND domain_id IS ?9",
            params![
                content,
                kind,
                tags,
                topic_key.as_deref(),
                stamp,
                id,
                placement_kind,
                repository_id,
                domain_id,
            ],
        )?;
        if updated == 0 {
            anyhow::bail!("memory #{id} not found");
        }
        return Ok(id);
    }
    if !options.force {
        let hits = recall_at(
            connection,
            placement,
            content,
            DEFAULT_RECALL_LIMIT,
            None,
            None,
        )?;
        if !hits.is_empty() {
            return Err(SimilarMemories { candidates: hits }.into());
        }
    }
    connection.execute(
        "INSERT INTO memories (
             content, kind, tags, created_at, updated_at, scope, topic_key, placement_kind, repository_id, domain_id
         )
         VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            content,
            kind,
            tags,
            stamp,
            scope,
            topic_key.as_deref().unwrap_or(""),
            placement_kind,
            repository_id,
            domain_id,
        ],
    )?;
    Ok(connection.last_insert_rowid())
}

pub fn recall(
    connection: &Connection,
    query: &str,
    limit: usize,
    kind: Option<&str>,
    max_chars: Option<usize>,
) -> Result<Vec<Memory>> {
    recall_scoped(
        connection,
        &ScopeId::global(),
        query,
        limit,
        kind,
        max_chars,
    )
}

pub fn recall_scoped(
    connection: &Connection,
    scope: &ScopeId,
    query: &str,
    limit: usize,
    kind: Option<&str>,
    max_chars: Option<usize>,
) -> Result<Vec<Memory>> {
    let prepared = fts_query(query);
    if prepared.is_empty() {
        return Ok(Vec::new());
    }
    let kind_filter = kind.map(str::trim).filter(|value| !value.is_empty());
    let limit = sqlite_limit(limit)?;
    let mut statement = connection.prepare(
        "SELECT m.id, m.content, m.kind, m.tags, m.created_at, m.updated_at, m.scope, m.topic_key,
                m.placement_kind, m.repository_id, m.domain_id
         FROM memories_fts f
         JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ?1
           AND (m.scope = ?2 OR (?2 <> 'global' AND m.scope = 'global'))
           AND (?4 = '' OR m.kind = ?4)
           AND (
               m.scope = ?2
               OR m.topic_key = ''
               OR NOT EXISTS (
                   SELECT 1
                   FROM memories scoped_topic
                   WHERE scoped_topic.scope = ?2
                     AND scoped_topic.topic_key = m.topic_key
                     AND scoped_topic.topic_key <> ''
               )
           )
         ORDER BY CASE WHEN m.scope = ?2 THEN 0 ELSE 1 END, bm25(memories_fts), m.created_at DESC, m.id DESC
         LIMIT ?3",
    )?;
    let rows = statement.query_map(
        params![prepared, scope.as_str(), limit, kind_filter.unwrap_or("")],
        memory_from_row,
    )?;
    let memories = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    Ok(take_char_budget(memories, max_chars))
}

pub fn recall_at(
    connection: &Connection,
    placement: &PlacementId,
    query: &str,
    limit: usize,
    kind: Option<&str>,
    max_chars: Option<usize>,
) -> Result<Vec<Memory>> {
    let prepared = fts_query(query);
    if prepared.is_empty() {
        return Ok(Vec::new());
    }
    let kind_filter = kind.map(str::trim).filter(|value| !value.is_empty());
    let limit = sqlite_limit(limit)?;
    let (placement_kind, repository_id, domain_id) = placement_parts(placement);
    let mut statement = connection.prepare(
        "SELECT m.id, m.content, m.kind, m.tags, m.created_at, m.updated_at, m.scope, m.topic_key,
                m.placement_kind, m.repository_id, m.domain_id
         FROM memories_fts f
         JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ?1
           AND m.placement_kind = ?2
           AND m.repository_id IS ?3
           AND m.domain_id IS ?4
           AND (?6 = '' OR m.kind = ?6)
         ORDER BY bm25(memories_fts), m.created_at DESC, m.id DESC
         LIMIT ?5",
    )?;
    let rows = statement.query_map(
        params![
            prepared,
            placement_kind,
            repository_id,
            domain_id,
            limit,
            kind_filter.unwrap_or(""),
        ],
        memory_from_row,
    )?;
    let memories = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    Ok(take_char_budget(memories, max_chars))
}

pub fn list(connection: &Connection, limit: usize) -> Result<Vec<Memory>> {
    list_scoped(connection, &ScopeId::global(), limit)
}

pub fn list_scoped(connection: &Connection, scope: &ScopeId, limit: usize) -> Result<Vec<Memory>> {
    let limit = sqlite_limit(limit)?;
    let mut statement = connection.prepare(
        "SELECT id, content, kind, tags, created_at, updated_at, scope, topic_key,
                placement_kind, repository_id, domain_id
         FROM memories
         WHERE scope = ?1 OR (?1 <> 'global' AND scope = 'global')
         ORDER BY CASE WHEN scope = ?1 THEN 0 ELSE 1 END, created_at DESC, id DESC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![scope.as_str(), limit], memory_from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn list_at(
    connection: &Connection,
    placement: &PlacementId,
    limit: usize,
) -> Result<Vec<Memory>> {
    let limit = sqlite_limit(limit)?;
    let (placement_kind, repository_id, domain_id) = placement_parts(placement);
    let mut statement = connection.prepare(
        "SELECT id, content, kind, tags, created_at, updated_at, scope, topic_key,
                placement_kind, repository_id, domain_id
         FROM memories
         WHERE placement_kind = ?1
           AND repository_id IS ?2
           AND domain_id IS ?3
         ORDER BY created_at DESC, id DESC
         LIMIT ?4",
    )?;
    let rows = statement.query_map(
        params![placement_kind, repository_id, domain_id, limit],
        memory_from_row,
    )?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn forget(connection: &Connection, id: i64) -> Result<bool> {
    forget_scoped(connection, &ScopeId::global(), id)
}

pub fn forget_scoped(connection: &Connection, scope: &ScopeId, id: i64) -> Result<bool> {
    Ok(connection.execute(
        "DELETE FROM memories WHERE id = ?1 AND scope = ?2",
        params![id, scope.as_str()],
    )? > 0)
}

pub fn forget_at(connection: &Connection, placement: &PlacementId, id: i64) -> Result<bool> {
    let (placement_kind, repository_id, domain_id) = placement_parts(placement);
    Ok(connection.execute(
        "DELETE FROM memories
         WHERE id = ?1
           AND placement_kind = ?2
           AND repository_id IS ?3
           AND domain_id IS ?4",
        params![id, placement_kind, repository_id, domain_id],
    )? > 0)
}

pub fn count(connection: &Connection) -> Result<i64> {
    count_scoped(connection, &ScopeId::global())
}

pub fn count_scoped(connection: &Connection, scope: &ScopeId) -> Result<i64> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM memories WHERE scope = ?1 OR (?1 <> 'global' AND scope = 'global')",
        params![scope.as_str()],
        |row| row.get(0),
    )?)
}

#[must_use]
pub fn normalize_topic_key(topic_key: Option<&str>) -> Option<String> {
    topic_key.map(|value| {
        value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    })
}

fn sqlite_limit(limit: usize) -> Result<i64> {
    i64::try_from(limit).context("memory limit exceeds SQLite range")
}

fn take_char_budget(memories: Vec<Memory>, max_chars: Option<usize>) -> Vec<Memory> {
    let Some(max_chars) = max_chars else {
        return memories;
    };
    let mut total = 0usize;
    let mut out = Vec::new();
    for memory in memories {
        let n = memory.content.chars().count();
        if !out.is_empty() && total.saturating_add(n) > max_chars {
            break;
        }
        total = total.saturating_add(n);
        out.push(memory);
    }
    out
}

fn memory_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Memory> {
    let placement_kind: String = row.get(8)?;
    let repository_id: Option<String> = row.get(9)?;
    let domain_id: Option<String> = row.get(10)?;
    let placement = match (
        placement_kind.as_str(),
        repository_id.as_deref(),
        domain_id.as_deref(),
    ) {
        ("repository", Some(repository), None) => repository.to_owned(),
        ("domain", None, Some(domain)) => format!("domain:{domain}"),
        ("universal", None, None) => "universal".to_owned(),
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(Memory {
        id: row.get(0)?,
        content: row.get(1)?,
        kind: row.get(2)?,
        tags: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        scope: row.get(6)?,
        topic_key: row.get(7)?,
        placement,
    })
}

fn placement_from_scope(scope: &ScopeId) -> Result<PlacementId> {
    if scope.is_global() {
        return Ok(PlacementId::Universal);
    }
    let repository = scope
        .as_str()
        .parse::<RepositoryId>()
        .map_err(|_| anyhow::anyhow!("invalid repository placement"))?;
    Ok(PlacementId::Repository(repository))
}

fn placement_parts(placement: &PlacementId) -> (&'static str, Option<&str>, Option<&str>) {
    match placement {
        PlacementId::Repository(repository) => ("repository", Some(repository.as_str()), None),
        PlacementId::Domain(domain) => ("domain", None, Some(domain.as_str())),
        PlacementId::Universal => ("universal", None, None),
    }
}

fn legacy_scope(placement: &PlacementId) -> String {
    match placement {
        PlacementId::Repository(repository) => repository.to_string(),
        PlacementId::Domain(_) => placement.to_string(),
        PlacementId::Universal => "global".to_owned(),
    }
}

fn fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|part| format!("\"{}\"", part.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    fn legacy_schema(connection: &Connection) {
        connection
            .execute_batch(
                "
                CREATE TABLE memories (
                    id INTEGER PRIMARY KEY,
                    content TEXT NOT NULL,
                    kind TEXT NOT NULL DEFAULT 'context',
                    tags TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    scope TEXT NOT NULL DEFAULT 'global',
                    topic_key TEXT NOT NULL DEFAULT ''
                );
                CREATE VIRTUAL TABLE memories_fts USING fts5(
                    content, tags, content='memories', content_rowid='id'
                );
                CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
                    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
                END;
                CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
                    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
                    VALUES ('delete', old.id, old.content, old.tags);
                END;
                CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
                    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
                    VALUES ('delete', old.id, old.content, old.tags);
                    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
                END;
                INSERT INTO memories (id, content, kind, tags, created_at, updated_at, scope, topic_key)
                VALUES (7, 'legacy row', 'note', '', 'before', 'before', 'global', '');
                ",
            )
            .unwrap();
    }

    #[test]
    fn pre_versioned_refusal_preserves_original_rows() {
        // Given
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy.db");
        let connection = Connection::open(&path).unwrap();
        legacy_schema(&connection);

        // When
        let failure = open(&path);

        // Then
        assert!(failure.is_err());
        assert_eq!(
            connection
                .query_row("SELECT content FROM memories WHERE id = 7", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "legacy row"
        );
        assert!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'schema_metadata'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap()
                == 0
        );
    }
}
