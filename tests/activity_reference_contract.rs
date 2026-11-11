#[path = "support/observable.rs"]
mod support;

use memocap::activity::{ActivityEvent, ActivityStore, RecordOutcome};
use serde_json::{json, Value};
use support::Fixture;

fn payload() -> Value {
    let hash = "a".repeat(64);
    let references: Vec<_> = [(7, "full"), (9, "partial")]
        .into_iter()
        .map(|(id, completeness)| {
            json!({"id":id,"placement":"universal",
            "completeness":completeness,"content_hash":hash,
            "read":{"tool":"memocap_read","arguments":{"id":id,
                "placement":"universal","content_hash":hash}}})
        })
        .collect();
    json!({"operation_id":"00000000-0000-0000-0000-000000000601",
        "related_operation_id":null,"started_at":chrono::Utc::now().to_rfc3339(),"elapsed_ms":0,
        "context":{"repository_ids":[],"session_id":"references","message_id":null,
            "actor":"plugin","backend":"local","origin":"plugin"},
        "detail":{"phase":"injection_prepared","metadata":{"status":"ok",
            "injected_ids":[7,9],"cache_hit":true,"references":references,
            "discovery":{"kind":"library"},"truncated":true}},
        "receipt":{"truncated":true,"result_limit":3,"max_chars":6000,"error_code":null}})
}

#[test]
fn cli_record_show_preserves_reference_metadata() {
    let fixture = Fixture::new();
    let payload = payload();
    assert!(fixture.b.is_dir());
    fixture.json(&["activity", "prepare", "--json"], true);

    let recorded = fixture.json(
        &[
            "activity",
            "record",
            "--payload",
            &payload.to_string(),
            "--json",
        ],
        true,
    );
    let shown = fixture.json(
        &[
            "activity",
            "show",
            payload["operation_id"].as_str().unwrap(),
            "--json",
        ],
        true,
    );

    assert_eq!(recorded["activity_status"], "recorded");
    assert_eq!(shown["events"][0]["detail"], payload["detail"]);
}

#[test]
fn legacy_persisted_event_remains_readable_and_duplicate_stable() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.db");
    let mut legacy = payload();
    let metadata = legacy["detail"]["metadata"].as_object_mut().unwrap();
    for field in ["references", "discovery", "truncated"] {
        metadata.remove(field);
    }
    let event: ActivityEvent = serde_json::from_value(legacy.clone()).unwrap();
    let encoded = format!(concat!(
        "{{\"operation_id\":\"00000000-0000-0000-0000-000000000601\",",
        "\"related_operation_id\":null,\"started_at\":{},\"elapsed_ms\":0,",
        "\"context\":{{\"repository_ids\":[],\"session_id\":\"references\",\"message_id\":null,",
        "\"actor\":\"plugin\",\"backend\":\"local\",\"origin\":\"plugin\"}},",
        "\"detail\":{{\"phase\":\"injection_prepared\",\"metadata\":{{\"status\":\"ok\",",
        "\"injected_ids\":[7,9],\"cache_hit\":true}}}},",
        "\"receipt\":{{\"truncated\":true,\"result_limit\":3,\"max_chars\":6000,\"error_code\":null}}}}"
    ), legacy["started_at"]);
    let mut store = ActivityStore::open(&path).unwrap();
    store.record(&event).unwrap();
    let raw = rusqlite::Connection::open(&path).unwrap();
    raw.execute("UPDATE activity_events SET event_json=?1", [&encoded])
        .unwrap();
    drop(store);

    let mut reopened = ActivityStore::open(&path).unwrap();
    let shown = reopened.show(&event.operation_id).unwrap();
    let duplicate = reopened.record(&event).unwrap();

    assert_eq!(serde_json::to_value(&shown[0].event).unwrap(), legacy);
    assert_eq!(duplicate, RecordOutcome::Duplicate);
    assert_eq!(serde_json::to_value(&event).unwrap(), legacy);
    assert_eq!(serde_json::to_string(&event).unwrap(), encoded);
}

#[test]
fn cli_rejects_read_route_identity_mismatch() {
    let fixture = Fixture::new();
    fixture.json(&["activity", "prepare", "--json"], true);
    let mut invalid = payload();
    invalid["detail"]["metadata"]["references"][0]["read"]["arguments"]["id"] = json!(8);

    let output = fixture
        .command(&[
            "activity",
            "record",
            "--payload",
            &invalid.to_string(),
            "--json",
        ])
        .output()
        .unwrap();

    assert!(!output.status.success());
}

#[test]
fn store_preserves_exact_origins_and_explicit_untruncated_full_references() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.db");
    let mut payload = payload();
    payload["detail"]["phase"] = json!("injection_observed");
    let metadata = &mut payload["detail"]["metadata"];
    metadata["discovery"] = json!({"kind":"origins","placements":["universal"]});
    metadata["truncated"] = json!(false);
    metadata["cache_hit"] = json!(false);
    metadata["references"][1]["completeness"] = json!("full");
    payload["receipt"]["truncated"] = json!(false);
    let event: ActivityEvent = serde_json::from_value(payload.clone()).unwrap();
    ActivityStore::open(&path).unwrap().record(&event).unwrap();

    let shown = ActivityStore::open_readonly(&path)
        .unwrap()
        .show(&event.operation_id)
        .unwrap();

    assert_eq!(serde_json::to_value(&shown[0].event).unwrap(), payload);
}

#[test]
fn store_rejects_inconsistent_or_unbounded_reference_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ActivityStore::open(&directory.path().join("core.db")).unwrap();
    let changes = [
        ("/detail/metadata/references/0/id", json!(0)),
        ("/detail/metadata/references/0/id", json!(10)),
        ("/detail/metadata/references/0/read/arguments/id", json!(9)),
        (
            "/detail/metadata/references/0/read/arguments/placement",
            json!("domain:other"),
        ),
        (
            "/detail/metadata/references/0/read/arguments/content_hash",
            json!("b".repeat(64)),
        ),
        (
            "/detail/metadata/references/0/read/tool",
            json!("other_tool"),
        ),
        (
            "/detail/metadata/references/0/content_hash",
            json!("A".repeat(64)),
        ),
        (
            "/detail/metadata/references/0/content_hash",
            json!("a".repeat(63)),
        ),
        ("/detail/metadata/references/0/placement", json!("domain:*")),
        (
            "/detail/metadata/references/0/completeness",
            json!("unknown"),
        ),
        (
            "/detail/metadata/references/0/read/arguments",
            json!({"id":7,"placement":"universal"}),
        ),
        (
            "/detail/metadata/discovery",
            json!({"kind":"origins","placements":["domain:other"]}),
        ),
        ("/detail/metadata/discovery", Value::Null),
        ("/detail/metadata/truncated", json!(false)),
        (
            "/detail/metadata/references",
            json!(vec![
                payload()["detail"]["metadata"]["references"][0].clone();
                101
            ]),
        ),
    ];
    for (pointer, replacement) in changes {
        let mut invalid = payload();
        *invalid.pointer_mut(pointer).unwrap() = replacement;

        match serde_json::from_value::<ActivityEvent>(invalid) {
            Err(_) => {}
            Ok(event) => assert!(store.record(&event).is_err(), "accepted {pointer}"),
        }
    }
}

#[test]
fn discovery_requires_explicit_bounded_distinct_exact_origins() {
    use memocap::discovery::{Discovery, Origins};
    let origins = Origins::try_from(vec![
        "universal".parse().unwrap(),
        "domain:rust/cli".parse().unwrap(),
    ])
    .unwrap();
    let selected = Discovery::Origins {
        placements: origins,
    };
    let wire = json!({"kind":"origins","placements":["universal","domain:rust/cli"]});

    let decoded: Discovery = serde_json::from_value(wire.clone()).unwrap();

    assert_eq!(decoded, selected);
    assert_eq!(serde_json::to_value(selected).unwrap(), wire);
    for invalid in [
        json!({}),
        json!({"kind":"library","placements":[]}),
        json!({"kind":"origins"}),
        json!({"kind":"origins","placements":[]}),
        json!({"kind":"origins","placements":["universal","universal"]}),
        json!({"kind":"origins","placements":["domain:*"]}),
        json!({"kind":"origins","placements":["repository:abc"]}),
        json!({"kind":"origins","placements":vec!["universal";101]}),
    ] {
        assert!(
            serde_json::from_value::<Discovery>(invalid.clone()).is_err(),
            "accepted {invalid}"
        );
    }
}
