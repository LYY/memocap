use std::{fs, path::Path};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, TransactionBehavior};

use crate::scope::{PlacementId, RepositoryId, ScopeId};

mod domains;
mod transfers;
mod visible;

pub use domains::{
    attach_domain, attached_domains, create_domain, delete_domain, detach_domain, domains,
};
pub use transfers::{
    copy_move, operation_status, replay_copy_move, CopyMoveAction, CopyMoveInput, CopyMoveRequest,
    CopyMoveResult,
};
pub use visible::{
    list_inventory, recall_visible, single_visible_source, visible_inventory, visible_sources,
    visible_status, InventoryMemory, PlacementCount, ShadowCause, Visibility, VisibleSource,
    VisibleStackStatus,
};

pub const DEFAULT_RECALL_LIMIT: usize = 3;
const SCHEMA_MAJOR: i64 = 1;
const SCHEMA_MINOR: i64 = 0;

const SCHEMA_V1: &str = "
CREATE TABLE schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    major INTEGER NOT NULL CHECK (major >= 1),
    minor INTEGER NOT NULL CHECK (minor >= 0)
);
INSERT INTO schema_metadata (singleton, major, minor) VALUES (1, 1, 0);
CREATE TABLE domains (
    domain_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
CREATE TABLE repository_domain_attachments (
    repository_id TEXT NOT NULL,
    domain_id TEXT NOT NULL REFERENCES domains(domain_id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (repository_id, domain_id),
    UNIQUE (repository_id, position)
);
CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'context',
    tags TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    topic_key TEXT NOT NULL DEFAULT '',
    placement_kind TEXT NOT NULL DEFAULT 'universal' CHECK (placement_kind IN ('repository', 'domain', 'universal')),
    repository_id TEXT,
    domain_id TEXT REFERENCES domains(domain_id) ON DELETE RESTRICT,
    CHECK (
        (placement_kind = 'repository' AND repository_id IS NOT NULL AND domain_id IS NULL)
        OR (placement_kind = 'domain' AND repository_id IS NULL AND domain_id IS NOT NULL)
        OR (placement_kind = 'universal' AND repository_id IS NULL AND domain_id IS NULL)
    )
);
CREATE TABLE memory_provenance (
    memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    source_memory_id INTEGER NOT NULL,
    source_placement_kind TEXT NOT NULL CHECK (source_placement_kind IN ('repository', 'domain', 'universal')),
    source_repository_id TEXT,
    source_domain_id TEXT,
    action TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    applicability_note TEXT,
    CHECK (
        (source_placement_kind = 'repository' AND source_repository_id IS NOT NULL AND source_domain_id IS NULL)
        OR (source_placement_kind = 'domain' AND source_repository_id IS NULL AND source_domain_id IS NOT NULL)
        OR (source_placement_kind = 'universal' AND source_repository_id IS NULL AND source_domain_id IS NULL)
    )
);
CREATE TABLE operation_ledger (
    operation_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    mutation TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
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
";

const SCHEMA_PRE_VERSIONED: &str = "
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    content TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'context',
    tags TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    topic_key TEXT NOT NULL DEFAULT ''
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, tags, content='memories', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', old.id, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', old.id, old.content, old.tags);
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaLifecycle {
    Created,
    Opened,
    ResetPreVersioned,
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
    let (connection, lifecycle) = open_with_lifecycle(path)?;
    if lifecycle == SchemaLifecycle::ResetPreVersioned {
        eprintln!("memocap: reset recognized pre-versioned database to schema 1.0");
    }
    Ok(connection)
}

pub fn open_with_lifecycle(path: &Path) -> Result<(Connection, SchemaLifecycle)> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("创建数据目录失败：{}", parent.display()))?;
    }
    let mut connection = Connection::open(path)
        .with_context(|| format!("打开本地记忆库失败：{}", path.display()))?;
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    let lifecycle = match schema_fingerprint(&connection)?.is_empty() {
        true => {
            create_schema_v1(&mut connection)?;
            SchemaLifecycle::Created
        }
        false if schema_matches_v1(&connection)? => open_schema_v1(&mut connection)?,
        false if schema_matches_pre_versioned(&connection)? => {
            reset_pre_versioned(&mut connection)?;
            SchemaLifecycle::ResetPreVersioned
        }
        false => anyhow::bail!("database schema is not a recognized memocap schema"),
    };
    connection.execute_batch("PRAGMA journal_mode = WAL;")?;
    Ok((connection, lifecycle))
}

fn create_schema_v1(connection: &mut Connection) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(SCHEMA_V1)?;
    transaction.commit()?;
    Ok(())
}

fn open_schema_v1(connection: &mut Connection) -> Result<SchemaLifecycle> {
    let version = schema_version(connection)?;
    if version.major != SCHEMA_MAJOR {
        anyhow::bail!("database schema major version is not supported");
    }
    if version.minor > SCHEMA_MINOR {
        anyhow::bail!("database schema minor version is newer than this binary");
    }
    if version.minor < SCHEMA_MINOR {
        migrate_lower_minor(connection, version.minor)?;
    }
    Ok(SchemaLifecycle::Opened)
}

fn reset_pre_versioned(connection: &mut Connection) -> Result<()> {
    reset_pre_versioned_with(connection, || Ok(()))
}

fn reset_pre_versioned_with<F>(connection: &mut Connection, before_create: F) -> Result<()>
where
    F: FnOnce() -> Result<()>,
{
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "
        DROP TRIGGER memories_au;
        DROP TRIGGER memories_ad;
        DROP TRIGGER memories_ai;
        DROP TABLE memories_fts;
        DROP TABLE memories;
        ",
    )?;
    before_create()?;
    transaction.execute_batch(SCHEMA_V1)?;
    transaction.commit()?;
    Ok(())
}

fn migrate_lower_minor(connection: &mut Connection, from_minor: i64) -> Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    run_lower_minor_migrations(
        &transaction,
        from_minor,
        SCHEMA_MINOR,
        LOWER_MINOR_MIGRATIONS,
    )?;
    transaction.execute(
        "UPDATE schema_metadata SET minor = ?1 WHERE singleton = 1",
        [SCHEMA_MINOR],
    )?;
    transaction.commit()?;
    Ok(())
}

fn run_lower_minor_migrations(
    transaction: &rusqlite::Transaction<'_>,
    from_minor: i64,
    target_minor: i64,
    migrations: &[LowerMinorMigration],
) -> Result<()> {
    if from_minor < 0 || target_minor < from_minor {
        anyhow::bail!("schema minor version is invalid");
    }
    for minor in from_minor..target_minor {
        let index = usize::try_from(minor).context("schema minor version is invalid")?;
        let Some(migration) = migrations.get(index) else {
            anyhow::bail!("database schema minor version has no registered migration");
        };
        migration(transaction)?;
    }
    Ok(())
}

type LowerMinorMigration = fn(&rusqlite::Transaction<'_>) -> Result<()>;
const LOWER_MINOR_MIGRATIONS: &[LowerMinorMigration] = &[];

#[derive(Debug, Clone, Copy)]
struct SchemaVersion {
    major: i64,
    minor: i64,
}

fn schema_version(connection: &Connection) -> Result<SchemaVersion> {
    let mut statement = connection.prepare("SELECT major, minor FROM schema_metadata")?;
    let mut rows = statement.query([])?;
    let Some(row) = rows.next()? else {
        anyhow::bail!("database schema metadata is malformed");
    };
    let version = SchemaVersion {
        major: row.get(0)?,
        minor: row.get(1)?,
    };
    if rows.next()?.is_some() || version.major < 1 || version.minor < 0 {
        anyhow::bail!("database schema metadata is malformed");
    }
    Ok(version)
}

fn schema_matches_pre_versioned(connection: &Connection) -> Result<bool> {
    Ok(schema_fingerprint(connection)? == expected_schema_fingerprint(SCHEMA_PRE_VERSIONED)?)
}

fn schema_matches_v1(connection: &Connection) -> Result<bool> {
    Ok(schema_fingerprint(connection)? == expected_schema_fingerprint(SCHEMA_V1)?)
}

type SchemaRow = (String, String, String, String);

fn schema_fingerprint(connection: &Connection) -> Result<Vec<SchemaRow>> {
    let mut statement = connection.prepare(
        "SELECT type, name, tbl_name, COALESCE(sql, '')
          FROM sqlite_schema
         WHERE name NOT GLOB 'sqlite_*'
          ORDER BY type, name",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            normalize_sql(&row.get::<_, String>(3)?),
        ))
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn expected_schema_fingerprint(schema: &str) -> Result<Vec<SchemaRow>> {
    let connection = Connection::open_in_memory()?;
    connection.execute_batch(schema)?;
    schema_fingerprint(&connection)
}

fn normalize_sql(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
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

    fn record_minor_zero(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
        transaction.execute("INSERT INTO migration_log (minor) VALUES (0)", [])?;
        Ok(())
    }

    fn record_minor_one(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
        transaction.execute("INSERT INTO migration_log (minor) VALUES (1)", [])?;
        Ok(())
    }

    #[test]
    fn lower_minor_dispatcher_runs_registered_migrations_in_order() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE migration_log (minor INTEGER NOT NULL)", [])
            .unwrap();
        let transaction = connection.transaction().unwrap();
        run_lower_minor_migrations(&transaction, 0, 2, &[record_minor_zero, record_minor_one])
            .unwrap();
        transaction.commit().unwrap();
        let applied = connection
            .prepare("SELECT minor FROM migration_log ORDER BY rowid")
            .unwrap()
            .query_map([], |row| row.get::<_, i64>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();

        assert_eq!(applied, [0, 1]);
        let transaction = connection.transaction().unwrap();
        assert!(run_lower_minor_migrations(&transaction, 0, 1, &[]).is_err());
    }

    #[test]
    fn reset_pre_versioned_rolls_back_when_creation_is_interrupted() {
        // Given
        let mut connection = Connection::open_in_memory().unwrap();
        legacy_schema(&connection);

        // When
        let failure =
            reset_pre_versioned_with(&mut connection, || anyhow::bail!("injected failure"));

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
