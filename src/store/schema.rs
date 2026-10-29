mod baseline;
mod identity;
mod lex;
mod structure;
mod validation;

use anyhow::{bail, ensure, Result};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use std::{path::Path, time::Duration};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchemaVersion {
    pub major: i64,
    pub minor: i64,
}

impl SchemaVersion {
    pub fn needs_upgrade(self) -> bool {
        self == Self { major: 2, minor: 1 }
    }
}

pub fn version(connection: &Connection) -> Result<SchemaVersion> {
    let mut statement = connection.prepare("SELECT singleton,major,minor FROM schema_metadata")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    match rows.as_slice() {
        [(1, major, minor)] if *major >= 1 && *minor >= 0 => Ok(SchemaVersion {
            major: *major,
            minor: *minor,
        }),
        _ => bail!("database schema metadata is malformed"),
    }
}

pub fn validate(connection: &Connection) -> Result<SchemaVersion> {
    let version = version(connection)?;
    match version {
        SchemaVersion { major: 2, minor: 1 } => validation::current(connection, false)?,
        SchemaVersion { major: 2, minor: 2 } => validation::current(connection, true)?,
        _ => bail!(
            "database schema version {}.{} is not supported",
            version.major,
            version.minor
        ),
    }
    Ok(version)
}

pub(crate) fn open(path: &Path, timeout: Duration) -> Result<(Connection, super::SchemaLifecycle)> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let filename = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("database path needs a filename"))?;
    let resolved = parent.canonicalize()?.join(filename);
    let mut connection = Connection::open_with_flags(
        resolved,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(timeout)?;
    connection.execute_batch("PRAGMA foreign_keys=ON;")?;
    let lifecycle = prepare(&mut connection)?;
    connection.execute_batch("PRAGMA journal_mode=WAL;")?;
    Ok((connection, lifecycle))
}

fn prepare(connection: &mut Connection) -> Result<super::SchemaLifecycle> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let lifecycle = if structure::objects(&transaction)?.is_empty() {
        transaction.execute_batch(baseline::CORE)?;
        transaction.execute_batch(baseline::ACTIVITY)?;
        transaction.execute_batch(identity::SQL)?;
        super::SchemaLifecycle::Created
    } else {
        match validate(&transaction)? {
            SchemaVersion { major: 2, minor: 1 } => {
                transaction.execute_batch(identity::SQL)?;
                transaction.execute("UPDATE schema_metadata SET minor=2 WHERE singleton=1", [])?;
                super::SchemaLifecycle::Upgraded
            }
            SchemaVersion { major: 2, minor: 2 } => super::SchemaLifecycle::Opened,
            _ => bail!("no registered schema migration"),
        }
    };
    ensure!(
        validate(&transaction)? == SchemaVersion { major: 2, minor: 2 },
        "schema preparation did not reach baseline"
    );
    transaction.commit()?;
    Ok(lifecycle)
}

#[cfg(test)]
mod testing;
