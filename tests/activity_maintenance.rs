use memocap::{activity::*, scope::OperationId};
use serde_json::{json, Value};
use std::process::Command;

const ACTIONS: [(&str, &str); 3] = [
    ("maintain_update", "updated"),
    ("maintain_merge", "updated"),
    ("maintain_delete", "deleted"),
];

fn payload(action: &str, status: &str) -> Value {
    json!({
        "operation_id": OperationId::from_request_fingerprint(action).as_str(),
        "related_operation_id": null,
        "started_at": "2000-01-01T00:00:00Z", "elapsed_ms": 1,
        "context": {"repository_ids": [], "session_id": "maintenance-test",
            "message_id": null, "actor": "plugin", "backend": "local", "origin": "plugin"},
        "detail": {"phase": "write", "metadata": {
            "action": action, "status": status, "memory_ids": [1], "placements": ["universal"]}},
        "receipt": null
    })
}

fn command(fixture: &tempfile::TempDir, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_memocap"));
    command
        .args(args)
        .current_dir(fixture.path())
        .env("MEMOCAP_DB", fixture.path().join("db"))
        .env("MEMOCAP_HOME", fixture.path())
        .env("HOME", fixture.path())
        .env("XDG_CONFIG_HOME", fixture.path().join("config"))
        .env("XDG_DATA_HOME", fixture.path().join("data"))
        .env("XDG_CACHE_HOME", fixture.path().join("cache"))
        .env_remove("MEMOCAP_ADDR")
        .env_remove("MEMOCAP_URL")
        .env_remove("MEMOCAP_ADDRESS")
        .env_remove("MEMOCAP_TOKEN");
    command
}

fn cli(fixture: &tempfile::TempDir, args: &[&str]) -> Value {
    let output = command(fixture, args).output().unwrap();
    assert!(output.status.success(), "{output:?}");
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn maintenance_actions_roundtrip_through_serialized_record_and_reopened_store() {
    for (action, status) in ACTIONS {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("db");
        let encoded = payload(action, status);
        let event: ActivityEvent = serde_json::from_value(encoded.clone()).unwrap();

        let outcome = ActivityStore::open(&database).unwrap().record(&event);

        assert_eq!(outcome.unwrap(), RecordOutcome::Recorded);
        let store = ActivityStore::open_readonly(&database).unwrap();
        let stored = store.show(&event.operation_id).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(serde_json::to_value(&stored[0].event).unwrap(), encoded);
        assert_eq!(
            store
                .list(&ActivityQuery {
                    writes_only: true,
                    ..ActivityQuery::default()
                })
                .unwrap(),
            stored
        );
    }
}

#[test]
fn maintenance_metadata_rejects_private_fields_and_unknown_variants() {
    for (action, status) in ACTIONS {
        for field in ["source", "claims", "data", "body"] {
            let mut encoded = payload(action, status);
            encoded["detail"]["metadata"][field] = json!("private fixture");

            let decoded = serde_json::from_value::<ActivityEvent>(encoded);

            assert!(decoded.is_err(), "{action}: {field}");
        }
    }
    for (field, invalid) in [("action", "maintain_keep"), ("status", "merged")] {
        let mut encoded = payload("maintain_update", "updated");
        encoded["detail"]["metadata"][field] = json!(invalid);
        assert!(serde_json::from_value::<ActivityEvent>(encoded).is_err());
    }
}

#[test]
fn maintenance_record_rejects_invalid_ids_and_placements_without_retaining_events() {
    for (action, status) in ACTIONS {
        let directory = tempfile::tempdir().unwrap();
        let mut store = ActivityStore::open(&directory.path().join("db")).unwrap();
        for ids in [json!([0]), json!([-1]), json!(vec![1; 10_001])] {
            let mut encoded = payload(action, status);
            encoded["detail"]["metadata"]["memory_ids"] = ids;
            let event: ActivityEvent = serde_json::from_value(encoded).unwrap();

            let outcome = store.record(&event);

            assert!(matches!(outcome, Err(ActivityError::InvalidInput(_))));
            assert!(store.show(&event.operation_id).unwrap().is_empty());
        }
        let mut encoded = payload(action, status);
        encoded["detail"]["metadata"]["placements"] = json!(vec!["universal"; 101]);
        let event: ActivityEvent = serde_json::from_value(encoded).unwrap();
        assert!(matches!(
            store.record(&event),
            Err(ActivityError::InvalidInput(_))
        ));
        encoded = payload(action, status);
        encoded["detail"]["metadata"]["placements"] = json!(["invalid"]);
        assert!(serde_json::from_value::<ActivityEvent>(encoded).is_err());
        assert!(store.list(&ActivityQuery::default()).unwrap().is_empty());
    }
}

#[test]
fn cli_reads_trusted_maintenance_records_without_changing_memory_or_schema() {
    let fixture = tempfile::tempdir().unwrap();
    let remembered = cli(
        &fixture,
        &["remember", "retained fixture", "--universal", "--json"],
    );
    let id = remembered["results"][0]["memory"]["id"].to_string();
    let read_args = ["read", &id, "--placement", "universal", "--json"];
    let before = cli(&fixture, &read_args);
    let schema_before = cli(&fixture, &["status", "--read-only", "--json"]);
    for (action, status) in ACTIONS {
        let encoded = payload(action, status);
        let operation = encoded["operation_id"].as_str().unwrap();

        let event: ActivityEvent = serde_json::from_value(encoded.clone()).unwrap();
        let recorded = ActivityStore::open(&fixture.path().join("db"))
            .unwrap()
            .record(&event)
            .unwrap();

        assert_eq!(recorded, RecordOutcome::Recorded);
        let shown = cli(&fixture, &["activity", "show", operation, "--json"]);
        assert_eq!(shown["events"].as_array().unwrap().len(), 1);
        assert_eq!(shown["events"][0]["detail"], encoded["detail"]);
    }
    let after = cli(&fixture, &read_args);
    assert_eq!(after["results"], before["results"]);
    let status = cli(&fixture, &["status", "--read-only", "--json"]);
    assert_eq!(status["inspection"]["schema_version"], "2.3");
    assert_eq!(status["inspection"], schema_before["inspection"]);
    let writes = cli(
        &fixture,
        &[
            "activity",
            "list",
            "--writes",
            "--session",
            "maintenance-test",
            "--json",
        ],
    );
    assert_eq!(writes["events"].as_array().unwrap().len(), 3);
    assert!(!writes.to_string().contains("retained fixture"));
    for (action, _) in ACTIONS {
        assert!(writes["events"].as_array().unwrap().iter().any(|event| {
            event["detail"]["phase"] == "write" && event["detail"]["metadata"]["action"] == action
        }));
    }
}

#[test]
fn cli_rejects_external_write_events_without_forging_history_or_changing_memory() {
    let fixture = tempfile::tempdir().unwrap();
    cli(
        &fixture,
        &["remember", "retained fixture", "--universal", "--json"],
    );
    let read_args = ["read", "1", "--placement", "universal", "--json"];
    let memory_before = cli(&fixture, &read_args);
    let schema_before = cli(&fixture, &["status", "--read-only", "--json"]);
    let history_before = cli(&fixture, &["activity", "list", "--json"]);

    for (action, status) in ACTIONS.into_iter().chain([
        ("remember", "inserted"),
        ("forget", "deleted"),
        ("copy", "inserted"),
        ("move", "updated"),
    ]) {
        let encoded = payload(action, status);

        let rejected = command(
            &fixture,
            &[
                "activity",
                "record",
                "--payload",
                &encoded.to_string(),
                "--json",
            ],
        )
        .output()
        .unwrap();

        assert!(!rejected.status.success());
        let receipt: Value = serde_json::from_slice(&rejected.stdout).unwrap();
        assert_eq!(receipt["status"], "failed");
        assert_eq!(
            receipt["error"]["message"],
            "write events require an actual core commit"
        );
        let shown = cli(
            &fixture,
            &[
                "activity",
                "show",
                encoded["operation_id"].as_str().unwrap(),
                "--json",
            ],
        );
        assert!(shown["events"].as_array().unwrap().is_empty());
    }
    let history_after = cli(&fixture, &["activity", "list", "--json"]);
    let memory_after = cli(&fixture, &read_args);
    let schema_after = cli(&fixture, &["status", "--read-only", "--json"]);
    assert_eq!(history_after["events"], history_before["events"]);
    assert_eq!(memory_after["results"], memory_before["results"]);
    assert_eq!(schema_after["inspection"], schema_before["inspection"]);
}
