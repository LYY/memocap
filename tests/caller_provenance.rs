#[path = "support/receipt_server.rs"]
mod receipt_server;
#[path = "support/observable.rs"]
mod support;
use serde_json::{json, Value};

const CALLER: &str =
    r#"{"actor":"plugin","session_id":"session-typed","message_id":"message-typed"}"#;

#[test]
fn cli_caller_survives_core_commit_and_activity_failure_without_replay() {
    let f = support::Fixture::new();
    let inserted = f.json(
        &[
            "remember",
            "--repo",
            f.b.to_str().unwrap(),
            "--caller-json",
            CALLER,
            "--json",
            "--",
            "literal --caller-json",
        ],
        true,
    );
    assert_eq!(
        inserted["caller"],
        serde_json::from_str::<Value>(CALLER).unwrap()
    );
    let activity = f.json(
        &[
            "activity",
            "list",
            "--writes",
            "--session",
            "session-typed",
            "--json",
        ],
        true,
    );
    let context = &activity["events"][0]["context"];
    assert_eq!(context["actor"], "plugin");
    assert_eq!(context["message_id"], "message-typed");
    assert_eq!(context["origin"], "cli");
    let invalid = f.json(
        &[
            "remember",
            "must not commit",
            "--caller-json",
            r#"{"actor":"plugin","session_id":"\n"}"#,
            "--json",
        ],
        false,
    );
    assert_eq!(invalid["status"], "failed");
    drop(memocap::store::open(&f.database).unwrap());
    memocap::store::open(&f.database).unwrap().execute_batch("CREATE TRIGGER reject_activity BEFORE INSERT ON activity_events BEGIN SELECT RAISE(FAIL,'injected activity failure'); END;").unwrap();
    let committed = f.json(
        &[
            "--caller-json",
            CALLER,
            "remember",
            "activity failure once",
            "--json",
        ],
        true,
    );
    assert_eq!(committed["activity_status"], "failed");
    assert_eq!(committed["caller"]["session_id"], "session-typed");
    let core = memocap::store::open(&f.database).unwrap();
    assert_eq!(
        core.query_row("SELECT count(*) FROM memories", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn http_caller_is_provenance_and_preserves_actual_server_origin() {
    let f = support::Fixture::new();
    let (address, server) =
        receipt_server::start(f.database.clone(), receipt_server::Mode::Normal, 4);
    let run = |args: &[&str]| {
        let output = f
            .command(args)
            .env("MEMOCAP_ADDR", &address)
            .env("MEMOCAP_TOKEN", "receipt-test-token")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let inserted = run(&["remember", "wire caller", "--caller-json", CALLER, "--json"]);
    assert_eq!(inserted["caller"]["actor"], "plugin");
    let history = run(&[
        "activity",
        "list",
        "--writes",
        "--session",
        "session-typed",
        "--json",
    ]);
    assert_eq!(
        history["events"][0]["context"]["message_id"],
        "message-typed"
    );
    assert_eq!(history["events"][0]["context"]["backend"], "remote");
    assert_eq!(history["events"][0]["context"]["origin"], "server");
    let report = server.join();
    assert!(
        matches!(&report.termination, receipt_server::Termination::Completed),
        "{report:?}"
    );
    assert_eq!(report.paths().len(), 4);
}

#[test]
fn independent_observations_keep_a_typed_durable_parent_recall() {
    let f = support::Fixture::new();
    let recall = f.json(&["recall", "missing", "--json"], true);
    let related = recall["operation_id"].clone();
    let mut payload = json!({"operation_id":"00000000-0000-0000-0000-000000000861", "related_operation_id": related,
        "started_at":chrono::Utc::now().to_rfc3339(),"elapsed_ms":0,
        "context":{"repository_ids":[],"actor":"plugin","session_id":"related-session","message_id":"related-message","origin":"plugin","backend":"local"},
        "detail":{"phase":"injection_prepared","metadata":{"status":"ok","injected_ids":[],"cache_hit":true}},"receipt":null});
    f.json(
        &[
            "activity",
            "record",
            "--payload",
            &payload.to_string(),
            "--json",
        ],
        true,
    );
    payload["detail"]["phase"] = json!("injection_observed");
    f.json(
        &[
            "activity",
            "record",
            "--payload",
            &payload.to_string(),
            "--json",
        ],
        true,
    );
    let shown = f.json(
        &[
            "activity",
            "show",
            "00000000-0000-0000-0000-000000000861",
            "--json",
        ],
        true,
    );
    assert_eq!(shown["events"].as_array().unwrap().len(), 2);
    assert!(shown["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["related_operation_id"] == related));
    let main = rusqlite::Connection::open(&f.database).unwrap();
    main.execute(
        "UPDATE activity_events SET started_at_ms=0 WHERE operation_id=?1",
        [related.as_str().unwrap()],
    )
    .unwrap();
    drop(main);
    let expired = f.json(
        &["activity", "show", related.as_str().unwrap(), "--json"],
        true,
    );
    assert_eq!(expired["history_status"], "not_found_or_expired");
    let retained = f.json(
        &[
            "activity",
            "show",
            "00000000-0000-0000-0000-000000000861",
            "--json",
        ],
        true,
    );
    assert_eq!(retained["events"][0]["related_operation_id"], related);
    payload["related_operation_id"] = json!("operation:invalid");
    f.json(
        &[
            "activity",
            "record",
            "--payload",
            &payload.to_string(),
            "--json",
        ],
        false,
    );
}

#[test]
fn unknown_remote_write_keeps_reported_caller_without_replay() {
    let f = support::Fixture::new();
    let (address, server) =
        receipt_server::start(f.database.clone(), receipt_server::Mode::MalformedWrite, 2);
    let output = f
        .command(&[
            "remember",
            "unknown caller once",
            "--caller-json",
            CALLER,
            "--json",
        ])
        .env("MEMOCAP_ADDR", address)
        .env("MEMOCAP_TOKEN", "receipt-test-token")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["status"], "outcome_unknown");
    assert_eq!(receipt["caller"]["session_id"], "session-typed");
    let report = server.join();
    assert!(
        matches!(&report.termination, receipt_server::Termination::Completed),
        "{report:?}"
    );
    assert_eq!(report.paths().len(), 2);
    let core = memocap::store::open(&f.database).unwrap();
    assert_eq!(
        core.query_row("SELECT count(*) FROM memories", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn capability_refusal_keeps_caller_without_a_write() {
    let f = support::Fixture::new();
    let (address, server) = receipt_server::start(f.database.clone(), receipt_server::Mode::Old, 1);
    let output = f
        .command(&[
            "remember",
            "unsupported caller",
            "--caller-json",
            CALLER,
            "--json",
        ])
        .env("MEMOCAP_ADDR", address)
        .env("MEMOCAP_TOKEN", "receipt-test-token")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["caller"]["message_id"], "message-typed");
    let report = server.join();
    assert!(
        matches!(&report.termination, receipt_server::Termination::Completed),
        "{report:?}"
    );
    assert_eq!(report.paths(), ["/v1/capabilities"]);
    assert!(!f.database.exists());
}
