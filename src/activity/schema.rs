use super::{ActivityError, Result};
use chrono::{Duration, Utc};
use rusqlite::Connection;
use std::{path::Path, time::Duration as Wait};

pub(super) fn open(path: &Path) -> Result<Connection> {
    crate::store::schema::open(path, Wait::from_millis(100))
        .map(|(connection, _)| connection)
        .map_err(core_error)
}

pub(super) fn open_readonly(path: &Path) -> Result<Connection> {
    let connection =
        crate::store::open_strict_readonly(path, Wait::from_millis(100)).map_err(core_error)?;
    let version = crate::store::schema::version(&connection).map_err(core_error)?;
    if version.needs_upgrade() {
        return Err(ActivityError::UnsupportedVersion {
            major: version.major,
            minor: version.minor,
        });
    }
    Ok(connection)
}

fn core_error(error: anyhow::Error) -> ActivityError {
    match error.downcast::<rusqlite::Error>() {
        Ok(error) => error.into(),
        Err(error) => ActivityError::InvalidInput(error.to_string()),
    }
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
