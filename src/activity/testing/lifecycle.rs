use super::*;

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
fn rejected_auxiliary_shapes_and_versions_are_never_reset() {
    for mutation in [
        "CREATE TABLE unexpected (sentinel TEXT); INSERT INTO unexpected VALUES ('keep')",
        "UPDATE activity_schema_metadata SET major = 2",
        "UPDATE activity_schema_metadata SET minor = 1",
        "DELETE FROM activity_schema_metadata",
        "ALTER TABLE activity_events ADD COLUMN unexpected TEXT",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let core = directory.path().join("db");
        drop(ActivityStore::open(&core).unwrap());
        let raw = Connection::open(activity_path(&core)).unwrap();
        raw.execute_batch(mutation).unwrap();
        let before = std::fs::read(activity_path(&core)).unwrap();

        assert!(ActivityStore::open(&core).is_err(), "{mutation}");

        assert_eq!(std::fs::read(activity_path(&core)).unwrap(), before);
        assert!(!core.exists());
    }
}

#[test]
fn corrupt_and_unmarked_empty_files_fail_without_replacement() {
    for bytes in [b"not sqlite".as_slice(), b"".as_slice()] {
        let directory = tempfile::tempdir().unwrap();
        let core = directory.path().join("db");
        std::fs::write(activity_path(&core), bytes).unwrap();

        assert!(ActivityStore::open(&core).is_err());

        assert_eq!(std::fs::read(activity_path(&core)).unwrap(), bytes);
        assert!(!core.exists());
    }
}

#[test]
fn locked_auxiliary_does_not_turn_committed_core_write_into_retry() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("db");
    let connection = memocap::store::open(&core).unwrap();
    let before_schema = snapshot(&connection);
    drop(ActivityStore::open(&core).unwrap());
    let lock = Connection::open(activity_path(&core)).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
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
fn auxiliary_paths_preserve_complete_filenames_and_isolate_each_core() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("memory.db");
    let second = directory.path().join("memory.other");
    let original = event("isolated");

    ActivityStore::open(&first)
        .unwrap()
        .record(&original)
        .unwrap();

    assert_eq!(
        activity_path(&first),
        directory.path().join("memory.db.activity.sqlite")
    );
    assert_eq!(
        activity_path(&second),
        directory.path().join("memory.other.activity.sqlite")
    );
    assert!(ActivityStore::open(&second)
        .unwrap()
        .show(&original.operation_id)
        .unwrap()
        .is_empty());
    assert!(!first.exists() && !second.exists());
}

#[test]
fn damaged_event_payload_fails_explicitly_on_read() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("db");
    let original = event("corrupt-row");
    let mut activity = ActivityStore::open(&core).unwrap();
    activity.record(&original).unwrap();
    Connection::open(activity_path(&core))
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
fn parent_symlink_is_supported_but_auxiliary_symlink_cannot_alias_core() {
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
    std::os::unix::fs::symlink(&core, activity_path(&core)).unwrap();

    assert!(ActivityStore::open(&core).is_err());

    assert_eq!(snapshot(&connection), before);
    assert_eq!(memocap::store::list(&connection, 20).unwrap().len(), 0);
    assert!(!absent_core.exists());
}

#[test]
fn open_store_record_and_hint_update_report_busy_without_partial_event() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("db");
    let mut activity = ActivityStore::open(&core).unwrap();
    let lock = Connection::open(activity_path(&core)).unwrap();
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
fn future_version_has_typed_error_and_retains_existing_events() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("db");
    let original = event("future");
    ActivityStore::open(&core)
        .unwrap()
        .record(&original)
        .unwrap();
    let raw = Connection::open(activity_path(&core)).unwrap();
    raw.execute("UPDATE activity_schema_metadata SET major=2", [])
        .unwrap();

    assert!(matches!(
        ActivityStore::open(&core),
        Err(ActivityError::UnsupportedVersion { major: 2, minor: 0 })
    ));

    assert_eq!(
        raw.query_row("SELECT count(*) FROM activity_events", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn missing_parent_directory_initializes_only_auxiliary_storage() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("new/parent/core.db");

    let activity = ActivityStore::open(&core).unwrap();

    assert!(activity.path().is_file());
    assert!(!core.exists());
    assert!(activity.list(&ActivityQuery::default()).unwrap().is_empty());
}
