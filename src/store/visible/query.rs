use anyhow::Result;
use rusqlite::{params, Connection};

use crate::scope::PlacementId;

use super::super::{memory_from_row, placement_parts, Memory};

pub(super) fn recalled_memories(
    connection: &Connection,
    placement: &PlacementId,
    prepared: &str,
    kind: Option<&str>,
) -> Result<Vec<Memory>> {
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
           AND (?5 = '' OR m.kind = ?5)
         ORDER BY bm25(memories_fts), m.created_at DESC, m.id DESC",
    )?;
    let rows = statement.query_map(
        params![
            prepared,
            placement_kind,
            repository_id,
            domain_id,
            kind.unwrap_or("")
        ],
        memory_from_row,
    )?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub(super) fn listed_memories(
    connection: &Connection,
    placement: &PlacementId,
) -> Result<Vec<Memory>> {
    let (placement_kind, repository_id, domain_id) = placement_parts(placement);
    let mut statement = connection.prepare(
        "SELECT id, content, kind, tags, created_at, updated_at, scope, topic_key,
                placement_kind, repository_id, domain_id
         FROM memories
         WHERE placement_kind = ?1
           AND repository_id IS ?2
           AND domain_id IS ?3
         ORDER BY created_at DESC, id DESC",
    )?;
    let rows = statement.query_map(
        params![placement_kind, repository_id, domain_id],
        memory_from_row,
    )?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub(super) fn source_topics(
    connection: &Connection,
    placement: &PlacementId,
) -> Result<Vec<String>> {
    let (placement_kind, repository_id, domain_id) = placement_parts(placement);
    let mut statement = connection.prepare(
        "SELECT DISTINCT topic_key
         FROM memories
         WHERE placement_kind = ?1
           AND repository_id IS ?2
           AND domain_id IS ?3
           AND topic_key <> ''",
    )?;
    let rows = statement.query_map(params![placement_kind, repository_id, domain_id], |row| {
        row.get::<_, String>(0)
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}
