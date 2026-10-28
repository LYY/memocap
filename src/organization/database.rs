use super::{Error, Result};
use crate::store::schema::{self, SchemaVersion};
use rusqlite::{Connection, OpenFlags};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) fn path(database: &Path) -> Result<PathBuf> {
    if !database.try_exists().map_err(Error::database)? {
        return Err(Error::before(
            "not_initialized",
            "memory database is not initialized",
        ));
    }
    std::path::absolute(database).map_err(Error::database)
}

pub(super) fn readonly(database: &Path) -> Result<Connection> {
    let connection = crate::readonly::open(database).map_err(Error::database)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(Error::database)?;
    validate(&connection)?;
    Ok(connection)
}

pub(super) fn writable(database: &Path) -> Result<Connection> {
    let parent = database
        .parent()
        .ok_or_else(|| Error::database("database path needs a parent"))?;
    let filename = database
        .file_name()
        .ok_or_else(|| Error::database("database path needs a filename"))?;
    let database = parent
        .canonicalize()
        .map_err(Error::database)?
        .join(filename);
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(Error::database)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(Error::database)?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(Error::database)?;
    validate(&connection)?;
    Ok(connection)
}

pub(super) fn validate(connection: &Connection) -> Result<()> {
    let version =
        schema::version(connection).map_err(|error| Error::before("incompatible_schema", error))?;
    match version {
        SchemaVersion {
            major: 2,
            minor: 0 | 1,
        } => {}
        _ => {
            return Err(Error::before(
                "unsupported_schema",
                format!(
                    "unsupported database schema {}.{}",
                    version.major, version.minor
                ),
            ))
        }
    }
    schema::validate(connection).map_err(|error| Error::before("incompatible_schema", error))?;
    if version.needs_upgrade() {
        return Err(Error::before(
            "upgrade_required",
            "schema 2.0 requires normal authorized preparation to upgrade to 2.1",
        ));
    }
    Ok(())
}
