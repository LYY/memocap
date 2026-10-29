use super::{
    database, Error, Key, MemoryId, Page, PageRequest, Provenance, Read, ReadRecord, ReadRequest,
    Result, Selection, Snapshot, SourceKind, UpperId,
};
use crate::{scope::PlacementId, store::CopyMoveAction};
use anyhow::{bail, Context};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;

const SNAPSHOT_COLUMNS: &str = "id,placement_kind,repository_id,domain_id,scope,content,kind,tags,topic_key,created_at,updated_at,organized_at";

pub fn page(database: &Path, request: &PageRequest) -> Result<Page> {
    request
        .validate()
        .map_err(|error| Error::before("invalid_request", error))?;
    let database = database::path(database)?;
    let connection = database::readonly(&database)?;
    let upper_id = match request.upper_id {
        Some(bound) => bound,
        None => {
            let maximum = connection
                .query_row("SELECT COALESCE(MAX(id),0) FROM memories", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(Error::database)?;
            UpperId::try_from(maximum).map_err(Error::database)?
        }
    };
    let state_filter = match request.selection {
        Selection::Pending => "AND organized_at IS NULL",
        Selection::All => "",
        Selection::OrganizedReference => "AND organized_at IS NOT NULL",
    };
    let lower_filter = if request.after_id.is_some() {
        "AND id > ?2"
    } else {
        "AND ?2 IS NULL"
    };
    let mut statement = connection.prepare(&format!("SELECT {SNAPSHOT_COLUMNS} FROM memories WHERE id <= ?1 {lower_filter} {state_filter} ORDER BY id ASC LIMIT 20")).map_err(Error::database)?;
    let mut rows = statement
        .query(params![
            i64::from(upper_id),
            request.after_id.map(i64::from)
        ])
        .map_err(Error::database)?;
    let mut records = Vec::with_capacity(20);
    while let Some(row) = rows.next().map_err(Error::database)? {
        records.push(snapshot_row(&connection, row).map_err(Error::database)?);
    }
    Ok(Page {
        database,
        selection: request.selection,
        upper_id,
        next_id: records.last().map(|record| record.id),
        exhausted: records.is_empty(),
        records,
    })
}

pub fn read(database: &Path, request: &ReadRequest) -> Result<Read> {
    request
        .validate()
        .map_err(|error| Error::before("invalid_request", error))?;
    let database = database::path(database)?;
    let connection = database::readonly(&database)?;
    let records = request
        .keys
        .iter()
        .map(|key| {
            Ok(ReadRecord {
                id: key.id,
                placement: key.placement.clone(),
                snapshot: snapshot(&connection, key)?,
            })
        })
        .collect::<anyhow::Result<_>>()
        .map_err(Error::database)?;
    Ok(Read { database, records })
}

pub(super) fn snapshot(connection: &Connection, key: &Key) -> anyhow::Result<Option<Snapshot>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {SNAPSHOT_COLUMNS} FROM memories WHERE id=?1"
    ))?;
    let mut rows = statement.query([i64::from(key.id)])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let record = snapshot_row(connection, row)?;
    Ok((record.placement == key.placement).then_some(record))
}

fn snapshot_row(connection: &Connection, row: &Row<'_>) -> anyhow::Result<Snapshot> {
    let id = MemoryId::try_from(row.get::<_, i64>(0)?).map_err(anyhow::Error::msg)?;
    let placement = match row.get::<_, String>(1)?.as_str() {
        "repository" => PlacementId::Repository(row.get::<_, String>(2)?.parse()?),
        "domain" => PlacementId::Domain(row.get::<_, String>(3)?.parse()?),
        "universal" => PlacementId::Universal,
        other => bail!("invalid stored placement kind {other}"),
    };
    let stored = connection.query_row("SELECT memory_id,source_memory_id,source_placement_kind,source_repository_id,source_domain_id,action,operation_id,created_at,applicability_note FROM memory_provenance WHERE memory_id=?1", [i64::from(id)], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, Option<String>>(8)?))
    }).optional()?;
    let provenance = stored
        .map(
            |(
                memory_id,
                source_memory_id,
                source_placement_kind,
                source_repository_id,
                source_domain_id,
                action,
                operation_id,
                created_at,
                applicability_note,
            )| {
                Ok::<_, anyhow::Error>(Provenance {
                    memory_id: memory_id.try_into().map_err(anyhow::Error::msg)?,
                    source_memory_id: source_memory_id.try_into().map_err(anyhow::Error::msg)?,
                    source_placement_kind: match source_placement_kind.as_str() {
                        "repository" => SourceKind::Repository,
                        "domain" => SourceKind::Domain,
                        "universal" => SourceKind::Universal,
                        other => bail!("invalid stored provenance placement kind {other}"),
                    },
                    source_repository_id,
                    source_domain_id,
                    action: match action.as_str() {
                        "copy" => CopyMoveAction::Copy,
                        "move" => CopyMoveAction::Move,
                        other => bail!("invalid stored provenance action {other}"),
                    },
                    operation_id,
                    created_at,
                    applicability_note,
                })
            },
        )
        .transpose()
        .context("read stored provenance")?;
    Ok(Snapshot {
        id,
        placement,
        scope: row.get(4)?,
        content: row.get(5)?,
        kind: row.get(6)?,
        tags: row.get(7)?,
        topic_key: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        organized_at: row.get(11)?,
        provenance,
    })
}
