#[path = "support/observable.rs"]
mod support;
use support::Fixture;

#[test]
fn receipts_distinguish_insert_update_reject_empty_and_parse_failure() {
    let f = Fixture::new();
    let inserted = f.json(&["remember", "unique receipt memory", "--json"], true);
    assert_eq!(inserted["status"], "inserted");
    assert_eq!(
        inserted["results"][0]["memory"]["content"],
        "unique receipt memory"
    );
    let updated = f.json(
        &["--json", "remember", "updated receipt memory", "--id", "1"],
        true,
    );
    assert_eq!(updated["status"], "updated");
    assert_eq!(updated["returned_ids"], serde_json::json!([1]));
    let rejected = f.json(&["remember", "updated receipt memory", "--json"], false);
    assert_eq!(rejected["status"], "rejected");
    let empty = f.json(&["recall", "unfindable", "--json"], true);
    assert_eq!(empty["status"], "empty");
    assert!(empty["error"].is_null());
    let malformed = f.json(&["recall", "--unexpected", "--json"], false);
    assert_eq!(malformed["status"], "failed");
    assert_eq!(malformed["format_version"], 1);
}

#[test]
fn unknown_schema_refuses_without_activity_or_schema_mutation() {
    let f = Fixture::new();
    let connection = rusqlite::Connection::open(&f.database).unwrap();
    connection
        .execute_batch("CREATE TABLE foreign_data(id INTEGER);")
        .unwrap();
    drop(connection);
    let before = std::fs::read(&f.database).unwrap();
    f.json(&["status", "--read-only", "--json"], false);
    f.json(&["remember", "must not commit", "--json"], false);
    assert_eq!(std::fs::read(&f.database).unwrap(), before);
    assert!(!f.database.with_extension("db.activity.sqlite").exists());
}

#[test]
fn committed_write_remains_successful_when_activity_insert_fails() {
    let f = Fixture::new();
    memocap::store::open(&f.database).unwrap().execute_batch("CREATE TRIGGER reject_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(FAIL,'injected activity failure'); END;").unwrap();
    let receipt = f.json(&["remember", "committed once", "--json"], true);
    assert_eq!(receipt["status"], "inserted");
    assert_eq!(receipt["activity_status"], "failed");
    assert!(receipt["warning"].is_string());
    let core = memocap::store::open(&f.database).unwrap();
    assert_eq!(
        core.query_row("SELECT count(*) FROM memories", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn read_only_status_does_not_initialize_or_change_existing_databases() {
    let f = Fixture::new();
    let missing = f.json(&["status", "--read-only", "--json"], true);
    assert_eq!(missing["inspection"]["core_status"], "not_initialized");
    assert!(!f.database.exists());
    assert!(!f.database.with_extension("db.activity.sqlite").exists());
    f.json(&["remember", "readonly proof", "--json"], true);
    let core = std::fs::read(&f.database).unwrap();
    let ready = f.json(&["status", "--read-only", "--json"], true);
    assert_eq!(ready["inspection"]["core_status"], "ready");
    assert_eq!(ready["inspection"]["activity_status"], "ready");
    assert_eq!(std::fs::read(&f.database).unwrap(), core);
    let normal = f.json(&["status", "--json"], true);
    assert_eq!(normal["inspection"]["activity_status"], "ready");
}

#[test]
fn multi_target_receipt_preserves_applicability_and_global_budget() {
    let f = Fixture::new();
    f.json(
        &[
            "remember",
            "shared release",
            "--universal",
            "--topic",
            "release",
            "--json",
        ],
        true,
    );
    f.json(
        &["remember", "local release", "--topic", "release", "--json"],
        true,
    );
    let receipt = f.json(
        &[
            "recall",
            "release",
            "--repo",
            f.a.to_str().unwrap(),
            "--repo",
            f.b.to_str().unwrap(),
            "--json",
        ],
        true,
    );
    assert_eq!(receipt["results"].as_array().unwrap().len(), 2);
    assert_eq!(
        receipt["results"][0]["applicable_repositories"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_ne!(
        receipt["results"][0]["applicable_repositories"],
        receipt["results"][1]["applicable_repositories"]
    );
    let limited = f.json(&["recall", "release", "--limit", "1", "--json"], true);
    assert_eq!(limited["returned_ids"].as_array().unwrap().len(), 1);
}
