use super::{ActivityError, Result};
use chrono::{Duration, Utc};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use std::{io::ErrorKind, path::Path, time::Duration as Wait};

const SCHEMA: &str = "
CREATE TABLE activity_schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    marker TEXT NOT NULL CHECK(marker='memocap-activity'),
    major INTEGER NOT NULL,
    minor INTEGER NOT NULL
);
INSERT INTO activity_schema_metadata VALUES(1,'memocap-activity',1,0);
CREATE TABLE activity_events (
    sequence INTEGER PRIMARY KEY,
    operation_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('write','recall','injection_prepared','injection_observed')),
    category TEXT NOT NULL CHECK(category IN ('write','read')),
    started_at_ms INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    event_json TEXT NOT NULL,
    UNIQUE(operation_id,phase)
);
CREATE INDEX activity_retention ON activity_events(category,started_at_ms DESC,sequence DESC);
CREATE TABLE repository_metadata (
    repository_id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT,
    canonical_path TEXT,
    identity_source TEXT,
    last_seen TEXT NOT NULL,
    last_seen_ms INTEGER NOT NULL
);";

pub(super) fn open(path: &Path) -> Result<Connection> {
    let missing = match std::fs::symlink_metadata(path) {
        Ok(_) => false,
        Err(error) if error.kind() == ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let filename = path
        .file_name()
        .ok_or_else(|| ActivityError::InvalidInput("activity path needs a filename".into()))?;
    if missing {
        std::fs::create_dir_all(parent)?;
    }
    let resolved = std::fs::canonicalize(parent)?.join(filename);
    let mut connection = Connection::open_with_flags(resolved, flags)?;
    connection.busy_timeout(Wait::from_millis(100))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let actual = fingerprint(&transaction)?;
    if actual.is_empty() && missing {
        transaction.execute_batch(SCHEMA)?;
    } else {
        validate(&transaction, actual)?;
    }
    prune(&transaction)?;
    transaction.commit()?;
    Ok(connection)
}

pub(super) fn open_readonly(path: &Path) -> Result<Connection> {
    let connection = crate::readonly::open(path)
        .map_err(|error| ActivityError::InvalidInput(error.to_string()))?;
    connection.busy_timeout(Wait::from_millis(100))?;
    validate(&connection, fingerprint(&connection)?)?;
    Ok(connection)
}

fn validate(connection: &Connection, actual: Vec<(String, String, String, String)>) -> Result<()> {
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(SCHEMA)?;
    if actual != fingerprint(&expected)? {
        return Err(ActivityError::UnknownSchema);
    }
    let mut statement =
        connection.prepare("SELECT marker,major,minor FROM activity_schema_metadata")?;
    let versions = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    match versions.as_slice() {
        [(marker, 1, 0)] if marker == "memocap-activity" => {}
        [(marker, major, minor)] if marker == "memocap-activity" => {
            return Err(ActivityError::UnsupportedVersion {
                major: *major,
                minor: *minor,
            });
        }
        _ => return Err(ActivityError::UnknownSchema),
    }
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(ActivityError::Corrupt(integrity));
    }
    Ok(())
}

fn fingerprint(connection: &Connection) -> Result<Vec<(String, String, String, String)>> {
    let mut statement = connection.prepare(
        "SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
    )?;
    let rows = statement.query_map([], |row| {
        let sql: String = row.get(3)?;
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            sql.split_whitespace().collect::<Vec<_>>().join(" "),
        ))
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub(super) fn cutoff_ms() -> i64 {
    (Utc::now() - Duration::days(30)).timestamp_millis()
}

pub(super) fn prune(connection: &Connection) -> Result<()> {
    connection.execute(
        "DELETE FROM activity_events WHERE category='read' AND started_at_ms<?1",
        [cutoff_ms()],
    )?;
    connection.execute_batch(
        "DELETE FROM activity_events WHERE category='read' AND sequence NOT IN
         (SELECT sequence FROM activity_events WHERE category='read' ORDER BY started_at_ms DESC,sequence DESC LIMIT 10000);
         DELETE FROM activity_events WHERE category='write' AND sequence NOT IN
         (SELECT sequence FROM activity_events WHERE category='write' ORDER BY started_at_ms DESC,sequence DESC LIMIT 1000);",
    )?;
    Ok(())
}
