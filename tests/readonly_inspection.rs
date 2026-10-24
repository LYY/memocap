use memocap::{activity, inspection, scope::RepositoryId, store};
use rusqlite::{types::Value, Connection, OpenFlags};
use std::path::Path;

type Schema = Vec<(String, String, String, Option<String>)>;
type BusinessRows = Vec<(String, Vec<Vec<Value>>)>;

fn logical_state(connection: &Connection) -> (Schema, BusinessRows) {
    let schema = connection
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Schema>>()
        .unwrap();
    let tables = schema.iter().filter(|(kind, ..)| kind == "table");
    let business_rows = tables
        .map(|(_, name, ..)| {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))
                .unwrap();
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..columns).map(|column| row.get(column)).collect()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<Vec<Value>>>>()
                .unwrap();
            (name.clone(), rows)
        })
        .collect();
    (schema, business_rows)
}

fn readonly(path: &Path) -> Connection {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn remember(connection: &Connection, repository: &RepositoryId, content: &str) {
    store::remember(
        connection,
        content,
        "context",
        "",
        repository.as_str(),
        true,
        None,
    )
    .unwrap();
}

#[test]
fn closed_wal_without_sidecars_is_inspected_without_logical_changes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("core.db");
    let repository: RepositoryId = format!("repository:{}", "1".repeat(64)).parse().unwrap();
    let writer = store::open(&path).unwrap();
    remember(&writer, &repository, "closed WAL business row");
    let before = logical_state(&writer);
    drop(writer);
    assert!(!root.path().join("core.db-wal").exists());
    assert!(!root.path().join("core.db-shm").exists());
    let bytes = std::fs::read(&path).unwrap();

    let inspected = inspection::inspect(&path, &repository).unwrap();

    assert_eq!(inspected.core_status, "ready");
    assert_eq!(inspected.visible.unwrap().addressable_total, 1);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(logical_state(&readonly(&path)), before);
    assert!(!root.path().join("core.db.activity.sqlite").exists());
}

#[test]
fn unknown_wal_schema_refuses_without_reset_or_logical_changes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("core.db");
    let repository: RepositoryId = format!("repository:{}", "2".repeat(64)).parse().unwrap();
    let writer = store::open(&path).unwrap();
    remember(&writer, &repository, "unknown schema business row");
    writer
        .execute("UPDATE schema_metadata SET major=3", [])
        .unwrap();
    let before = logical_state(&writer);
    drop(writer);
    let bytes = std::fs::read(&path).unwrap();

    assert!(inspection::inspect(&path, &repository).is_err());

    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(logical_state(&readonly(&path)), before);
    assert!(!root.path().join("core.db.activity.sqlite").exists());
}

#[test]
fn live_wal_reads_only_commits_and_keeps_one_snapshot_across_second_commit() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("core.db");
    let repository: RepositoryId = format!("repository:{}", "3".repeat(64)).parse().unwrap();
    let writer = store::open(&path).unwrap();
    writer
        .execute_batch("PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    let core_bytes = std::fs::read(&path).unwrap();
    remember(&writer, &repository, "first committed live WAL");
    assert_eq!(std::fs::read(&path).unwrap(), core_bytes);
    assert!(
        std::fs::metadata(root.path().join("core.db-wal"))
            .unwrap()
            .len()
            > 32
    );

    let snapshot = store::open_strict_readonly(&path, std::time::Duration::from_secs(5)).unwrap();

    assert!(!snapshot.is_autocommit());
    writer.execute_batch("BEGIN IMMEDIATE;").unwrap();
    remember(&writer, &repository, "second uncommitted live WAL");
    assert_eq!(
        inspection::inspect(&path, &repository)
            .unwrap()
            .visible
            .unwrap()
            .addressable_total,
        1
    );
    writer.execute_batch("COMMIT;").unwrap();
    let sources = store::visible_sources(&snapshot, &repository).unwrap();
    assert_eq!(
        store::visible_status(&snapshot, &sources)
            .unwrap()
            .addressable_total,
        1
    );
    assert_eq!(
        inspection::inspect(&path, &repository)
            .unwrap()
            .visible
            .unwrap()
            .addressable_total,
        2
    );
    assert_eq!(std::fs::read(&path).unwrap(), core_bytes);
    assert!(snapshot.execute("DELETE FROM memories", []).is_err());
    assert_eq!(
        store::visible_status(&snapshot, &sources)
            .unwrap()
            .addressable_total,
        1
    );
}

#[test]
fn main_wal_inspection_preserves_expired_events_and_schema() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("core.db");
    let repository: RepositoryId = format!("repository:{}", "4".repeat(64)).parse().unwrap();
    drop(store::open(&path).unwrap());
    drop(activity::ActivityStore::open(&path).unwrap());
    let main = Connection::open(&path).unwrap();
    main.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    let expired = activity::ActivityEvent {
        operation_id: "00000000-0000-0000-0000-000000000711".parse().unwrap(),
        related_operation_id: None,
        started_at: "1970-01-01T00:00:00Z".into(),
        elapsed_ms: 0,
        context: activity::ActivityContext::default(),
        detail: activity::ActivityDetail::Recall(activity::RecallActivity {
            status: activity::RecallStatus::Empty,
            searched_placements: vec![],
            query_terms: vec!["expired".into()],
            matched_ids: vec![],
            returned_ids: vec![],
        }),
        receipt: None,
    };
    main.execute("INSERT INTO activity_events(operation_id,phase,category,started_at_ms,recorded_at,event_json) VALUES (?1,'recall','read',0,'1970-01-01T00:00:00Z',?2)", rusqlite::params![expired.operation_id.as_str(), serde_json::to_string(&expired).unwrap()]).unwrap();
    let before = logical_state(&main);
    let bytes = std::fs::read(&path).unwrap();

    let inspected = inspection::inspect(&path, &repository).unwrap();

    assert_eq!(inspected.activity_status, "ready");
    assert!(inspected.activity_error.is_none());
    assert_eq!(logical_state(&main), before);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(
        main.query_row(
            "SELECT count(*) FROM activity_events WHERE started_at_ms=0",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn missing_main_does_not_create_parent_directories() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("missing/core.db");
    let repository: RepositoryId = format!("repository:{}", "5".repeat(64)).parse().unwrap();

    let inspected = inspection::inspect(&path, &repository).unwrap();

    assert_eq!(inspected.core_status, "not_initialized");
    assert_eq!(inspected.activity_status, "not_initialized");
    assert!(!path.parent().unwrap().exists());
    assert!(activity::ActivityStore::open_readonly(&path).is_err());
    assert!(!path.parent().unwrap().exists());
}
