use super::*;

#[test]
fn old_recall_is_pruned_while_old_write_remains_available() {
    let directory = tempfile::tempdir().unwrap();
    let mut activity = ActivityStore::open(&directory.path().join("db")).unwrap();
    let mut old_write = event("old-write");
    old_write.started_at = (chrono::Utc::now() - chrono::Duration::days(31)).to_rfc3339();
    let mut old_recall = old_write.clone();
    old_recall.detail = ActivityDetail::Recall(RecallActivity {
        status: RecallStatus::Empty,
        searched_placements: vec![],
        query_terms: vec![],
        matched_ids: vec![],
        returned_ids: vec![],
    });

    activity.record(&old_write).unwrap();
    activity.record(&old_recall).unwrap();

    assert_eq!(activity.show(&old_write.operation_id).unwrap().len(), 1);
    assert_eq!(
        activity.show(&old_write.operation_id).unwrap()[0].event,
        old_write
    );
}

#[test]
fn retention_caps_reads_and_writes_separately_and_expires_on_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let core = directory.path().join("db");
    drop(ActivityStore::open(&core).unwrap());
    let raw = Connection::open(activity_path(&core)).unwrap();
    let sample = event("bulk");
    let json = serde_json::to_string(&sample).unwrap();
    raw.execute("WITH RECURSIVE series(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM series WHERE n<10005) INSERT INTO activity_events(operation_id,phase,category,started_at_ms,recorded_at,event_json) SELECT printf('read-%d',n),'recall','read',?1,'fixture',?2 FROM series", rusqlite::params![chrono::Utc::now().timestamp_millis(), json]).unwrap();
    raw.execute("WITH RECURSIVE series(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM series WHERE n<1005) INSERT INTO activity_events(operation_id,phase,category,started_at_ms,recorded_at,event_json) SELECT printf('write-%d',n),'write','write',?1,'fixture',?2 FROM series", rusqlite::params![chrono::Utc::now().timestamp_millis(), json]).unwrap();

    drop(ActivityStore::open(&core).unwrap());

    let counts: (i64, i64) = raw
        .query_row(
            "SELECT sum(category='read'), sum(category='write') FROM activity_events",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(counts, (10000, 1000));
    let mut activity = ActivityStore::open(&core).unwrap();
    activity.record(&event("next-write")).unwrap();
    let mut next_read = event("next-read");
    next_read.detail = ActivityDetail::InjectionPrepared(InjectionActivity {
        status: InjectionStatus::Skipped,
        injected_ids: vec![],
        cache_hit: true,
    });
    activity.record(&next_read).unwrap();
    assert_eq!(
        raw.query_row("SELECT count(*) FROM activity_events", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        11000
    );
    raw.execute(
        "UPDATE activity_events SET started_at_ms = 0 WHERE category='read'",
        [],
    )
    .unwrap();
    drop(ActivityStore::open(&core).unwrap());
    assert_eq!(
        raw.query_row("SELECT count(*) FROM activity_events", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1000
    );
}
