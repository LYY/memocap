use std::{fs, path::Path};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, TransactionBehavior};

use crate::scope::ScopeId;

pub const DEFAULT_RECALL_LIMIT: usize = 3;

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
}

#[derive(Debug)]
pub struct SimilarMemories {
    pub candidates: Vec<Memory>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeMigration {
    One(i64),
    All,
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
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("创建数据目录失败：{}", parent.display()))?;
    }
    let connection = Connection::open(path)
        .with_context(|| format!("打开本地记忆库失败：{}", path.display()))?;
    connection.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
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
        ",
    )?;
    add_topic_key_if_missing(&connection)?;
    Ok(connection)
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
    if let Some(id) = options.overwrite_id {
        let updated = connection.execute(
            "UPDATE memories
             SET content = ?1, kind = ?2, tags = ?3, topic_key = COALESCE(?4, topic_key), updated_at = ?5
             WHERE id = ?6 AND scope = ?7",
            params![content, kind, tags, topic_key.as_deref(), stamp, id, scope.as_str()],
        )?;
        if updated == 0 {
            anyhow::bail!("memory #{id} not found");
        }
        return Ok(id);
    }
    if !options.force {
        let hits = recall_exact_scope(connection, scope, content, DEFAULT_RECALL_LIMIT, None)?;
        if !hits.is_empty() {
            return Err(SimilarMemories { candidates: hits }.into());
        }
    }
    connection.execute(
        "INSERT INTO memories (content, kind, tags, created_at, updated_at, scope, topic_key)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)",
        params![
            content,
            kind,
            tags,
            stamp,
            scope.as_str(),
            topic_key.as_deref().unwrap_or("")
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
        "SELECT m.id, m.content, m.kind, m.tags, m.created_at, m.updated_at, m.scope, m.topic_key
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

pub fn list(connection: &Connection, limit: usize) -> Result<Vec<Memory>> {
    list_scoped(connection, &ScopeId::global(), limit)
}

pub fn list_scoped(connection: &Connection, scope: &ScopeId, limit: usize) -> Result<Vec<Memory>> {
    let limit = sqlite_limit(limit)?;
    let mut statement = connection.prepare(
        "SELECT id, content, kind, tags, created_at, updated_at, scope, topic_key
         FROM memories
         WHERE scope = ?1 OR (?1 <> 'global' AND scope = 'global')
         ORDER BY CASE WHEN scope = ?1 THEN 0 ELSE 1 END, created_at DESC, id DESC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![scope.as_str(), limit], memory_from_row)?;
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

pub fn scope_migration_count(
    connection: &Connection,
    source: &ScopeId,
    migration: ScopeMigration,
) -> Result<i64> {
    match migration {
        ScopeMigration::One(id) => Ok(connection.query_row(
            "SELECT COUNT(*) FROM memories WHERE scope = ?1 AND id = ?2",
            params![source.as_str(), id],
            |row| row.get(0),
        )?),
        ScopeMigration::All => Ok(connection.query_row(
            "SELECT COUNT(*) FROM memories WHERE scope = ?1",
            params![source.as_str()],
            |row| row.get(0),
        )?),
    }
}

pub fn migrate_scope(
    connection: &mut Connection,
    source: &ScopeId,
    destination: &ScopeId,
    migration: ScopeMigration,
    dry_run: bool,
) -> Result<i64> {
    if source == destination {
        anyhow::bail!("source and destination scopes must differ");
    }
    let moved = scope_migration_count(connection, source, migration)?;
    if dry_run || moved == 0 {
        return Ok(moved);
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    match migration {
        ScopeMigration::One(id) => move_memory(&transaction, source, destination, id)?,
        ScopeMigration::All => {
            for id in migration_ids(&transaction, source)? {
                move_memory(&transaction, source, destination, id)?;
            }
        }
    }
    transaction.commit()?;
    Ok(moved)
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

fn add_topic_key_if_missing(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(memories)")?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    let has_topic_key = columns
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|column| column == "topic_key");
    if !has_topic_key {
        connection
            .execute_batch("ALTER TABLE memories ADD COLUMN topic_key TEXT NOT NULL DEFAULT ''")?;
    }
    Ok(())
}

fn recall_exact_scope(
    connection: &Connection,
    scope: &ScopeId,
    query: &str,
    limit: usize,
    kind: Option<&str>,
) -> Result<Vec<Memory>> {
    let prepared = fts_query(query);
    if prepared.is_empty() {
        return Ok(Vec::new());
    }
    let limit = sqlite_limit(limit)?;
    let kind_filter = kind.map(str::trim).filter(|value| !value.is_empty());
    let mut statement = connection.prepare(
        "SELECT m.id, m.content, m.kind, m.tags, m.created_at, m.updated_at, m.scope, m.topic_key
         FROM memories_fts f
         JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ?1
           AND m.scope = ?2
           AND (?4 = '' OR m.kind = ?4)
         ORDER BY bm25(memories_fts), m.created_at DESC, m.id DESC
         LIMIT ?3",
    )?;
    let rows = statement.query_map(
        params![prepared, scope.as_str(), limit, kind_filter.unwrap_or("")],
        memory_from_row,
    )?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn migration_ids(transaction: &rusqlite::Transaction<'_>, source: &ScopeId) -> Result<Vec<i64>> {
    let mut statement =
        transaction.prepare("SELECT id FROM memories WHERE scope = ?1 ORDER BY id")?;
    let rows = statement.query_map(params![source.as_str()], |row| row.get(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn move_memory(
    transaction: &rusqlite::Transaction<'_>,
    source: &ScopeId,
    destination: &ScopeId,
    id: i64,
) -> Result<()> {
    let updated = transaction.execute(
        "UPDATE memories SET scope = ?1 WHERE id = ?2 AND scope = ?3",
        params![destination.as_str(), id, source.as_str()],
    )?;
    if updated != 1 {
        anyhow::bail!("memory #{id} not found in source scope");
    }
    Ok(())
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
    Ok(Memory {
        id: row.get(0)?,
        content: row.get(1)?,
        kind: row.get(2)?,
        tags: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        scope: row.get(6)?,
        topic_key: row.get(7)?,
    })
}

fn fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|part| format!("\"{}\"", part.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" AND ")
}
