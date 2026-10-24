mod error;
mod hints;
mod model;
mod schema;
mod serde_ids;
mod validation;

pub use error::ActivityError;
pub use model::*;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, ActivityError>;

pub struct ActivityStore {
    connection: Connection,
    path: PathBuf,
}

pub fn record_after_commit(core_path: &Path, event: &ActivityEvent) -> ActivityStatus {
    match ActivityStore::open(core_path).and_then(|mut activity| activity.record(event)) {
        Ok(RecordOutcome::Recorded) => ActivityStatus::Recorded,
        Ok(RecordOutcome::Duplicate) => ActivityStatus::Duplicate,
        Err(error) => ActivityStatus::Failed {
            warning: error.to_string(),
        },
    }
}

impl ActivityStore {
    pub fn open_readonly(core_path: &Path) -> Result<Self> {
        let path = core_path.to_path_buf();
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let filename = path
            .file_name()
            .ok_or_else(|| ActivityError::InvalidInput("activity path needs a filename".into()))?;
        let resolved = parent.canonicalize()?.join(filename);
        let connection = schema::open_readonly(&resolved)?;
        Ok(Self { connection, path })
    }

    pub fn open(core_path: &Path) -> Result<Self> {
        let path = core_path.to_path_buf();
        let connection = schema::open(&path)?;
        Ok(Self { connection, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn prepare(core_path: &Path) -> Result<Self> {
        let mut store = Self::open(core_path)?;
        let transaction = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        schema::prune(&transaction)?;
        transaction.commit()?;
        Ok(store)
    }

    pub fn record(&mut self, event: &ActivityEvent) -> Result<RecordOutcome> {
        let started_at_ms = validation::event(event)?;
        let encoded = serde_json::to_string(event)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: Option<String> = transaction
            .query_row(
                "SELECT event_json FROM activity_events WHERE operation_id=?1 AND phase=?2",
                params![event.operation_id.as_str(), event.detail.phase()],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            return if previous == encoded {
                Ok(RecordOutcome::Duplicate)
            } else {
                Err(ActivityError::Conflict)
            };
        }
        transaction.execute(
            "INSERT INTO activity_events(operation_id,phase,category,started_at_ms,recorded_at,event_json)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![event.operation_id.as_str(), event.detail.phase(), event.detail.category(), started_at_ms, Utc::now().to_rfc3339(), encoded],
        )?;
        schema::prune(&transaction)?;
        transaction.commit()?;
        Ok(RecordOutcome::Recorded)
    }

    pub fn list(&self, query: &ActivityQuery<'_>) -> Result<Vec<StoredActivity>> {
        let mut statement = self.connection.prepare(
            "SELECT sequence, recorded_at, event_json FROM activity_events
             WHERE (?1=0 OR category='write')
             AND (?2 IS NULL OR EXISTS (SELECT 1 FROM json_each(event_json,'$.context.repository_ids') WHERE value=?2))
             AND (?3 IS NULL OR json_extract(event_json,'$.context.session_id')=?3)
             AND (?4 IS NULL OR operation_id=?4)
             AND (category='write' OR started_at_ms>=?5)
             ORDER BY started_at_ms DESC, sequence DESC LIMIT ?6 OFFSET ?7",
        )?;
        let rows = statement.query_map(
            params![
                query.writes_only,
                query.repository.map(|id| id.as_str()),
                query.session_id,
                query.operation_id.map(|id| id.as_str()),
                schema::cutoff_ms(),
                i64::from(query.limit.min(10000)),
                i64::from(query.offset),
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?;
        rows.map(|row| decode(row?)).collect()
    }

    pub fn show(&self, operation_id: &crate::scope::OperationId) -> Result<Vec<StoredActivity>> {
        let mut statement = self.connection.prepare(
            "SELECT sequence, recorded_at, event_json FROM activity_events
             WHERE operation_id=?1 AND (category='write' OR started_at_ms>=?2) ORDER BY sequence",
        )?;
        let rows =
            statement.query_map(params![operation_id.as_str(), schema::cutoff_ms()], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
        rows.map(|row| decode(row?)).collect()
    }
}

fn decode((event_id, recorded_at, encoded): (i64, String, String)) -> Result<StoredActivity> {
    let event: ActivityEvent = serde_json::from_str(&encoded)
        .map_err(|error| ActivityError::Corrupt(error.to_string()))?;
    validation::event(&event).map_err(|error| ActivityError::Corrupt(error.to_string()))?;
    Ok(StoredActivity {
        event_id,
        recorded_at,
        event,
    })
}
