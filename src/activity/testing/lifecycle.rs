use super::*;

#[test]
fn readonly_activity_reports_busy_promptly_when_schema_is_exclusively_locked() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("locked.db");
    drop(ActivityStore::open(&core).unwrap());
    let mut lock = Connection::open(&core).unwrap();
    lock.execute_batch("PRAGMA journal_mode=DELETE").unwrap();
    let _exclusive = lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Exclusive)
        .unwrap();

    let started = std::time::Instant::now();
    let opened = ActivityStore::open_readonly(&core);
    let elapsed = started.elapsed();

    assert!(matches!(opened, Err(ActivityError::Busy)));
    assert!(
        elapsed < std::time::Duration::from_secs(1),
        "readonly activity waited {elapsed:?} for the schema lock"
    );
}

fn snapshot(connection: &Connection) -> Vec<(String, String)> {
    connection
        .prepare("SELECT name, coalesce(sql, '') FROM sqlite_schema ORDER BY name")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

#[test]
fn rejected_main_shapes_and_versions_are_never_reset() {
    for mutation in [
        "DROP INDEX activity_retention",
        "UPDATE schema_metadata SET major = 3",
        "UPDATE schema_metadata SET major = 1,minor = 1",
        "DELETE FROM schema_metadata",
        "ALTER TABLE activity_events ADD COLUMN unexpected TEXT NOT NULL",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let core = directory.path().join("db");
        drop(ActivityStore::open(&core).unwrap());
        let raw = Connection::open(&core).unwrap();
        raw.execute_batch(mutation).unwrap();
        let before = snapshot(&raw);

        assert!(ActivityStore::open(&core).is_err(), "{mutation}");

        assert_eq!(snapshot(&raw), before);
    }
}

#[test]
fn corrupt_main_files_fail_without_replacement() {
    for bytes in [b"not sqlite".as_slice(), b"unrecognized data".as_slice()] {
        let directory = tempfile::tempdir().unwrap();
        let core = directory.path().join("db");
        std::fs::write(&core, bytes).unwrap();

        assert!(ActivityStore::open(&core).is_err());

        assert_eq!(std::fs::read(&core).unwrap(), bytes);
    }
}

#[test]
fn activity_lock_after_core_commit_does_not_turn_write_into_retry() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("db");
    let connection = memocap::store::open(&core).unwrap();
    let before_schema = snapshot(&connection);
    drop(ActivityStore::open(&core).unwrap());
    let id = memocap::store::remember(
        &connection,
        "sqlite committed sentinel",
        "note",
        "tag",
        "global",
        true,
        None,
    )
    .unwrap();
    let before = memocap::store::list(&connection, 20).unwrap();
    let lock = Connection::open(&core).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();

    let status = record_after_commit(&core, &event("committed"));

    assert!(matches!(status, ActivityStatus::Failed { .. }));
    assert!(matches!(
        ActivityStore::open(&core),
        Err(ActivityError::Busy)
    ));
    assert_eq!(memocap::store::list(&connection, 20).unwrap(), before);
    assert_eq!(
        memocap::store::recall(&connection, "sentinel", 20, None, None).unwrap()[0].id,
        id
    );
    assert_eq!(snapshot(&connection), before_schema);
    lock.execute_batch("ROLLBACK").unwrap();
    assert!(ActivityStore::open(&core)
        .unwrap()
        .show(&event("committed").operation_id)
        .unwrap()
        .is_empty());
}

#[test]
fn main_paths_preserve_complete_filenames_and_isolate_each_store() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("memory.db");
    let second = directory.path().join("memory.other");
    let original = event("isolated");

    ActivityStore::open(&first)
        .unwrap()
        .record(&original)
        .unwrap();

    assert_eq!(ActivityStore::open(&first).unwrap().path(), first);
    assert_eq!(ActivityStore::open(&second).unwrap().path(), second);
    assert!(ActivityStore::open(&second)
        .unwrap()
        .show(&original.operation_id)
        .unwrap()
        .is_empty());
    assert!(first.exists() && second.exists());
}

#[test]
fn damaged_event_payload_fails_explicitly_on_read() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("db");
    let original = event("corrupt-row");
    let mut activity = ActivityStore::open(&core).unwrap();
    activity.record(&original).unwrap();
    Connection::open(&core)
        .unwrap()
        .execute("UPDATE activity_events SET event_json = '{}'", [])
        .unwrap();

    assert!(matches!(
        activity.show(&original.operation_id),
        Err(ActivityError::Corrupt(_))
    ));
}

#[cfg(unix)]
#[test]
fn parent_symlink_is_supported_but_main_file_symlink_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let alias = directory.path().join("alias");
    std::os::unix::fs::symlink(directory.path(), &alias).unwrap();
    let core = alias.join("core.db");
    let connection = memocap::store::open(&core).unwrap();
    let before = snapshot(&connection);
    let absent_core = alias.join("absent.db");
    ActivityStore::open(&absent_core)
        .unwrap()
        .record(&event("parent-alias"))
        .unwrap();
    let file_alias = alias.join("file-alias.db");
    std::os::unix::fs::symlink(&core, &file_alias).unwrap();

    assert!(ActivityStore::open(&file_alias).is_err());

    assert_eq!(snapshot(&connection), before);
    assert_eq!(memocap::store::list(&connection, 20).unwrap().len(), 0);
    assert!(absent_core.exists());
}

#[test]
fn open_store_record_and_hint_update_report_busy_without_partial_event() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("db");
    let mut activity = ActivityStore::open(&core).unwrap();
    let lock = Connection::open(&core).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let original = event("locked-record");
    let hint = RepositoryHint {
        repository_id: repository('a'),
        display_name: None,
        canonical_path: None,
        identity_source: None,
        last_seen: original.started_at.clone(),
    };

    assert!(matches!(
        activity.record(&original),
        Err(ActivityError::Busy)
    ));
    assert!(matches!(
        activity.update_repository_hint(&hint),
        Err(ActivityError::Busy)
    ));

    lock.execute_batch("ROLLBACK").unwrap();
    assert!(activity.show(&original.operation_id).unwrap().is_empty());
    assert_eq!(activity.record(&original).unwrap(), RecordOutcome::Recorded);
    assert_eq!(
        activity.record(&original).unwrap(),
        RecordOutcome::Duplicate
    );
}

#[test]
fn unknown_major_refuses_and_retains_existing_events() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("db");
    let original = event("future");
    ActivityStore::open(&core)
        .unwrap()
        .record(&original)
        .unwrap();
    let raw = Connection::open(&core).unwrap();
    raw.execute("UPDATE schema_metadata SET major=3", [])
        .unwrap();

    assert!(ActivityStore::open(&core).is_err());

    assert_eq!(
        raw.query_row("SELECT count(*) FROM activity_events", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn missing_parent_directory_initializes_whole_main_storage() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("new/parent/core.db");

    let activity = ActivityStore::open(&core).unwrap();

    assert!(activity.path().is_file());
    assert!(core.exists());
    assert!(activity.list(&ActivityQuery::default()).unwrap().is_empty());
}
