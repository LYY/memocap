use super::*;

#[test]
fn outcomes_accept_known_ids_and_rejection_tool_observations() {
    for status in ["saved", "skipped", "denied", "failed", "unknown"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("capture.db");
        let mut candidate = payload();
        candidate["detail"]["metadata"]["status"] = json!(status);
        if status == "skipped" {
            candidate["detail"]["metadata"]["memory_ids"] = json!([]);
            candidate["detail"]["metadata"]["write_attempts"] = json!(0);
        }
        candidate["detail"]["metadata"]["tool_calls"] = json!(u64::MAX);
        let candidate: ActivityEvent = serde_json::from_value(candidate).unwrap();

        let mut store = ActivityStore::open(&path).unwrap();
        store.record(&candidate).unwrap();

        assert_eq!(
            store.show(&candidate.operation_id).unwrap()[0].event,
            candidate
        );
    }
}

#[test]
fn invalid_capture_metadata_is_rejected_without_an_event() {
    for (field, invalid) in [
        ("reason", json!("")),
        ("reason", json!("x".repeat(65))),
        ("reason", json!("free text")),
        ("reason", json!("\u{975e}ASCII")),
        ("reason", json!("line\nbreak")),
        ("model_calls", json!(4)),
        ("write_attempts", json!(2)),
        ("memory_ids", json!([0])),
        ("memory_ids", json!([-1])),
        ("memory_ids", json!([41, 41])),
        ("memory_ids", json!((1..=101).collect::<Vec<i64>>())),
        ("memory_ids", json!([])),
        ("write_attempts", json!(0)),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let mut store = ActivityStore::open(&directory.path().join("capture.db")).unwrap();
        let mut candidate = payload();
        candidate["detail"]["metadata"][field] = invalid;
        let candidate: ActivityEvent = serde_json::from_value(candidate).unwrap();

        let recorded = store.record(&candidate);

        assert!(
            matches!(recorded, Err(ActivityError::InvalidInput(_))),
            "{field}"
        );
        assert!(store.list(&ActivityQuery::default()).unwrap().is_empty());
    }
}

#[test]
fn metadata_accepts_exact_bounds_and_empty_non_saved_outcomes() {
    for status in ["saved", "skipped", "denied", "failed", "unknown"] {
        let directory = tempfile::tempdir().unwrap();
        let mut candidate = payload();
        let metadata = &mut candidate["detail"]["metadata"];
        metadata["reason"] = json!("A".repeat(64));
        metadata["status"] = json!(status);
        metadata["model_calls"] = json!(0);
        metadata["tool_calls"] = json!(0);
        metadata["memory_ids"] = json!((1..=100).collect::<Vec<i64>>());
        if status != "saved" {
            metadata["memory_ids"] = json!([]);
            metadata["write_attempts"] = json!(0);
        }
        let candidate: ActivityEvent = serde_json::from_value(candidate).unwrap();
        let mut store = ActivityStore::open(&directory.path().join("capture.db")).unwrap();

        store.record(&candidate).unwrap();

        assert_eq!(
            store.show(&candidate.operation_id).unwrap()[0].event,
            candidate
        );
    }
}

#[test]
fn skipped_capture_cannot_report_ids() {
    let directory = tempfile::tempdir().unwrap();
    let mut candidate = payload();
    candidate["detail"]["metadata"]["status"] = json!("skipped");
    let candidate: ActivityEvent = serde_json::from_value(candidate).unwrap();
    let mut store = ActivityStore::open(&directory.path().join("capture.db")).unwrap();

    assert!(matches!(
        store.record(&candidate),
        Err(ActivityError::InvalidInput(_))
    ));
}

#[test]
fn capture_schema_refuses_private_unknown_missing_and_wrong_typed_fields() {
    for (field, invalid) in [
        ("body", json!("private body")),
        ("secret", json!("private secret")),
        ("source", json!("private source")),
        ("status", json!("ok")),
        ("tool_calls", json!(-1)),
        ("tool_calls", json!(1.5)),
        ("model_calls", json!(-1)),
        ("write_attempts", json!(-1)),
    ] {
        let mut candidate = payload();
        candidate["detail"]["metadata"][field] = invalid;

        assert!(
            serde_json::from_value::<ActivityEvent>(candidate).is_err(),
            "{field}"
        );
    }
    for field in [
        "status",
        "reason",
        "memory_ids",
        "model_calls",
        "tool_calls",
        "write_attempts",
    ] {
        let mut candidate = payload();
        candidate["detail"]["metadata"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            serde_json::from_value::<ActivityEvent>(candidate).is_err(),
            "{field}"
        );
    }
}
