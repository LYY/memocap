use anyhow::{ensure, Result};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

pub fn memory_by_id(connection: &Connection, id: i64) -> Result<Option<super::Memory>> {
    use rusqlite::OptionalExtension;
    Ok(connection
        .query_row(
            "SELECT id, content, kind, tags, created_at, updated_at, scope, topic_key,
         placement_kind, repository_id, domain_id FROM memories WHERE id=?1",
            [id],
            super::memory_from_row,
        )
        .optional()?)
}

pub fn open_readonly(path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    validate(&connection)?;
    Ok(connection)
}

pub fn open_strict_readonly(path: &Path) -> Result<Connection> {
    let connection = crate::readonly::open(path)?;
    validate(&connection)?;
    Ok(connection)
}

fn validate(connection: &Connection) -> Result<()> {
    ensure!(
        super::schema_matches_v1(connection)?,
        "database schema is not a recognized memocap schema"
    );
    let version = super::schema_version(connection)?;
    ensure!(
        version.major == super::SCHEMA_MAJOR && version.minor == super::SCHEMA_MINOR,
        "database schema version is not supported by this binary"
    );
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    ensure!(
        integrity == "ok",
        "database integrity check failed: {integrity}"
    );
    Ok(())
}
