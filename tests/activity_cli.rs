#[path = "support/observable.rs"]
mod support;
use support::Fixture;

#[test]
fn activity_contains_actual_commits_and_recall_phases_without_content_copies() {
    let f = Fixture::new();
    let write = f.json(&["remember", "private memory body", "--json"], true);
    f.json(&["remember", "", "--json"], false);
    let writes = f.json(&["activity", "list", "--writes", "--json"], true);
    assert_eq!(writes["events"].as_array().unwrap().len(), 1);
    assert_eq!(writes["events"][0]["operation_id"], write["operation_id"]);
    assert!(!writes.to_string().contains("private memory body"));
    let recall = f.json(&["recall", "private", "--json"], true);
    let shown = f.json(
        &[
            "activity",
            "show",
            recall["operation_id"].as_str().unwrap(),
            "--json",
        ],
        true,
    );
    assert_eq!(shown["events"][0]["detail"]["phase"], "recall");
    assert_eq!(
        shown["events"][0]["detail"]["metadata"]["returned_ids"],
        serde_json::json!([1])
    );
}

#[test]
fn replay_and_missing_delete_do_not_duplicate_completed_write_activity() {
    let f = Fixture::new();
    let remembered = f.json(&["remember", "transfer activity proof", "--json"], true);
    let source = remembered["results"][0]["memory"]["placement"]
        .as_str()
        .unwrap();
    let copy = [
        "scope",
        "copy",
        "--id",
        "1",
        "--from",
        source,
        "--to",
        "universal",
        "--operation-id",
        "00000000-0000-0000-0000-000000000411",
        "--json",
    ];
    f.json(&copy, true);
    f.json(&copy, true);
    let missing = f.json(&["forget", "999", "--json"], true);
    assert_eq!(missing["status"], "empty");
    let activity = f.json(&["activity", "list", "--writes", "--json"], true);
    assert_eq!(activity["events"].as_array().unwrap().len(), 2);
    f.json(&["forget", "1", "--json"], true);
    let activity = f.json(&["activity", "list", "--writes", "--json"], true);
    assert_eq!(
        activity["events"][0]["detail"]["metadata"]["memory_ids"],
        serde_json::json!([1])
    );
}

#[test]
fn plugin_metadata_phases_deduplicate_and_support_multiple_targets() {
    let f = Fixture::new();
    let a = f.json(&["scope", "show", "--json"], true);
    let b = f.json(
        &["scope", "show", "--repo", f.b.to_str().unwrap(), "--json"],
        true,
    );
    let payload = serde_json::json!({"operation_id":"00000000-0000-0000-0000-000000000401",
        "started_at":chrono::Utc::now().to_rfc3339(),"elapsed_ms":0,
        "context":{"repository_ids":[a["targets"][0]["repository_id"],b["targets"][0]["repository_id"]],"actor":"plugin","session_id":"session-1","message_id":"message-1","origin":"plugin","backend":"local"},
        "detail":{"phase":"injection_prepared","metadata":{"status":"ok","injected_ids":[1],"cache_hit":true}},"receipt":null}).to_string();
    let args = [
        "activity",
        "record",
        "--payload",
        &payload,
        "--repo",
        f.a.to_str().unwrap(),
        "--repo",
        f.b.to_str().unwrap(),
        "--json",
    ];
    let first = f.json(&args, true);
    let duplicate = f.json(&args, true);
    assert_eq!(first["activity_status"], "recorded");
    assert_eq!(duplicate["activity_status"], "duplicate");
    let events = f.json(
        &["activity", "list", "--session", "session-1", "--json"],
        true,
    );
    assert_eq!(events["events"].as_array().unwrap().len(), 1);
    assert_eq!(events["events"][0]["context"]["origin"], "plugin");
}

#[test]
fn recall_activity_preserves_the_applied_result_and_character_budget() {
    let f = Fixture::new();
    f.json(&["remember", "budgeted recall", "--json"], true);
    let recall = f.json(
        &[
            "recall",
            "budgeted",
            "--limit",
            "0",
            "--max-chars",
            "20",
            "--json",
        ],
        true,
    );
    let shown = f.json(
        &[
            "activity",
            "show",
            recall["operation_id"].as_str().unwrap(),
            "--json",
        ],
        true,
    );
    assert_eq!(shown["events"][0]["receipt"]["result_limit"], 0);
    assert_eq!(shown["events"][0]["receipt"]["max_chars"], 20);
    assert_eq!(shown["events"][0]["receipt"]["truncated"], true);
}

#[test]
fn missing_history_fails_without_creating_main_storage() {
    let f = Fixture::new();
    let receipt = f.json(&["activity", "list", "--json"], false);
    assert_eq!(receipt["status"], "failed");
    assert!(!f.database.exists());
}
