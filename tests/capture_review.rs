#[path = "support/observable.rs"]
mod support;
#[path = "capture_review/validation.rs"]
mod validation;

use memocap::activity::{
    ActivityError, ActivityEvent, ActivityQuery, ActivityStore, RecordOutcome,
};
use serde_json::{json, Value};

fn payload() -> Value {
    json!({
        "operation_id":"00000000-0000-0000-0000-000000000611",
        "started_at":chrono::Utc::now().to_rfc3339(),"elapsed_ms":0,
        "context":{"repository_ids":[],"actor":"plugin","session_id":"capture-session",
            "message_id":null,"origin":"plugin","backend":"local"},
        "detail":{"phase":"capture_review","metadata":{"status":"saved","reason":"saved_verified",
            "memory_ids":[41],"model_calls":3,"tool_calls":7,"write_attempts":1}},"receipt":null
    })
}

#[test]
fn capture_roundtrips_deduplicates_and_conflicts_through_store() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("capture.db");
    let original: ActivityEvent = serde_json::from_value(payload()).unwrap();
    let mut store = ActivityStore::open(&path).unwrap();

    assert_eq!(store.record(&original).unwrap(), RecordOutcome::Recorded);
    assert_eq!(store.record(&original).unwrap(), RecordOutcome::Duplicate);

    let mut changed = payload();
    changed["detail"]["metadata"]["reason"] = json!("different_reason");
    let changed: ActivityEvent = serde_json::from_value(changed).unwrap();
    assert!(matches!(
        store.record(&changed),
        Err(ActivityError::Conflict)
    ));
    drop(store);
    let readonly = ActivityStore::open_readonly(&path).unwrap();
    let shown = readonly.show(&original.operation_id).unwrap();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].event, original);
    assert_eq!(readonly.list(&ActivityQuery::default()).unwrap(), shown);
    assert!(readonly
        .list(&ActivityQuery {
            writes_only: true,
            ..ActivityQuery::default()
        })
        .unwrap()
        .is_empty());
}

#[test]
fn capture_uses_read_category_and_thirty_day_retention() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("capture.db");
    let mut old = payload();
    old["started_at"] = json!((chrono::Utc::now() - chrono::Duration::days(31)).to_rfc3339());
    let old: ActivityEvent = serde_json::from_value(old).unwrap();
    let mut store = ActivityStore::open(&path).unwrap();

    store.record(&old).unwrap();

    assert!(store.show(&old.operation_id).unwrap().is_empty());
    assert_eq!(
        rusqlite::Connection::open(&path)
            .unwrap()
            .query_row("SELECT count(*) FROM activity_events", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let current: ActivityEvent = serde_json::from_value(payload()).unwrap();
    store.record(&current).unwrap();
    assert_eq!(
        rusqlite::Connection::open(&path)
            .unwrap()
            .query_row("SELECT category FROM activity_events", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "read"
    );
}

#[test]
fn prior_event_encoding_and_dedup_survive_upgrade() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("prior.db");
    let mut original = payload();
    original["detail"] = json!({"phase":"recall","metadata":{"status":"empty","searched_placements":[],"query_terms":[],"matched_ids":[],"returned_ids":[]}});
    let original: ActivityEvent = serde_json::from_value(original).unwrap();
    let encoded = serde_json::to_string(&original).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(include_str!("fixtures/schema-2.2.sql"))
        .unwrap();
    connection
        .execute(
            "INSERT INTO activity_events VALUES(700,?1,'recall','read',?2,'unchanged',?3)",
            rusqlite::params![
                original.operation_id.as_str(),
                chrono::Utc::now().timestamp_millis(),
                encoded
            ],
        )
        .unwrap();
    drop(connection);

    let mut store = ActivityStore::open(&path).unwrap();
    assert_eq!(store.record(&original).unwrap(), RecordOutcome::Duplicate);

    let shown = store.show(&original.operation_id).unwrap();
    assert_eq!(shown[0].event_id, 700);
    assert_eq!(shown[0].recorded_at, "unchanged");
    assert_eq!(shown[0].event, original);
}

#[test]
fn cli_records_lists_and_shows_capture_after_prior_upgrade() {
    let fixture = support::Fixture::new();
    let prior = rusqlite::Connection::open(&fixture.database).unwrap();
    prior
        .execute_batch(include_str!("fixtures/schema-2.2.sql"))
        .unwrap();
    drop(prior);
    let status = fixture.json(&["status", "--read-only", "--json"], true);
    assert_eq!(status["inspection"]["core_status"], "upgrade_needed");
    fixture.json(&["activity", "prepare", "--json"], true);
    let encoded = payload().to_string();
    let args = [
        "activity",
        "record",
        "--payload",
        &encoded,
        "--repo",
        fixture.b.to_str().unwrap(),
        "--json",
    ];

    let recorded = fixture.json(&args, true);

    assert_eq!(recorded["activity_status"], "recorded");
    assert_eq!(fixture.json(&args, true)["activity_status"], "duplicate");
    let shown = fixture.json(
        &[
            "activity",
            "show",
            "00000000-0000-0000-0000-000000000611",
            "--json",
        ],
        true,
    );
    assert_eq!(
        shown["events"][0]["detail"]["metadata"],
        payload()["detail"]["metadata"]
    );
    let listed = fixture.json(
        &["activity", "list", "--session", "capture-session", "--json"],
        true,
    );
    assert_eq!(listed["events"], shown["events"]);
    let mut invalid = payload();
    invalid["detail"]["metadata"]["model_calls"] = json!(4);
    fixture.json(
        &[
            "activity",
            "record",
            "--payload",
            &invalid.to_string(),
            "--json",
        ],
        false,
    );
    assert_eq!(
        fixture.json(&["activity", "list", "--json"], true)["events"],
        shown["events"]
    );
}
