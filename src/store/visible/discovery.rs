use anyhow::Result;
use rusqlite::{params, Connection};

use super::{super::memory_from_row, recall::fts_query, RecallOptions, TargetedMemory};
use crate::discovery::Discovery;

#[path = "lexical.rs"]
mod lexical;

pub fn recall_discovery(
    connection: &Connection,
    discovery: &Discovery,
    options: RecallOptions<'_>,
) -> Result<Vec<TargetedMemory>> {
    let prepared = fts_query(options.query, options.match_mode);
    if prepared.is_empty() {
        return Ok(vec![]);
    }
    let prepared = lexical::expand_query(connection, options)?;
    let mut statement = connection.prepare(
        "SELECT m.id, m.content, m.kind, m.tags, m.created_at, m.updated_at, m.scope, m.topic_key,
                m.placement_kind, m.repository_id, m.domain_id
         FROM memories_fts f JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ?1 AND (?2 = '' OR m.kind = ?2)
         ORDER BY bm25(memories_fts), m.created_at DESC, m.id DESC",
    )?;
    let rows = statement.query_map(
        params![prepared, options.kind.map(str::trim).unwrap_or("")],
        memory_from_row,
    )?;
    let mut memories = Vec::new();
    for row in rows {
        let memory = row?;
        let included = match discovery {
            Discovery::Library => true,
            Discovery::Origins { placements } => placements
                .as_slice()
                .iter()
                .any(|placement| placement.to_string() == memory.placement),
        };
        if included {
            memories.push(TargetedMemory {
                memory,
                applicability: vec![],
            });
        }
    }
    Ok(memories)
}
