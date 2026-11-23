#[path = "maintenance_native/support.rs"]
mod support;
use serde_json::json;
use support::Fixture;

#[test]
fn unsupported_decisions_modes_shapes_and_limits_do_not_mutate() {
    let fixture = Fixture::new();
    let expected = fixture.snapshot(1);
    let valid = json!({"mode":"all","group":{"action":"refine","expected":expected,"content":"replacement"},"dependencies":[]});
    let mut requests = Vec::new();
    for action in ["keep", "unknown"] {
        requests.push(
            json!({"mode":"all","group":{"action":action,"expected":expected},"dependencies":[]}),
        );
    }
    let mut pending = valid.clone();
    pending["mode"] = json!("pending");
    requests.push(pending);
    let mut too_many = valid.clone();
    too_many["dependencies"] = json!([
        fixture.snapshot(2),
        fixture.snapshot(3),
        fixture.snapshot(4)
    ]);
    requests.push(too_many);
    for content in ["x".repeat(1201), "bad\0body".into(), " ".into()] {
        let mut invalid = valid.clone();
        invalid["group"]["content"] = json!(content);
        requests.push(invalid);
    }
    let mut incomplete = valid.clone();
    incomplete["group"]["expected"]
        .as_object_mut()
        .unwrap()
        .remove("provenance");
    requests.push(incomplete);
    let mut unknown = valid.clone();
    unknown["confirmed"] = json!(true);
    requests.push(unknown);
    let mut oversized = valid;
    oversized["group"]["expected"]["content"] = json!("x".repeat(65536));
    requests.push(oversized);

    for request in requests {
        let receipt = fixture.invoke(&["organize", "maintain", "--json"], &request.to_string());
        assert_eq!(receipt["error"]["code"], "invalid_request", "{receipt}");
        assert_eq!(fixture.snapshot(1), expected);
        assert_eq!(fixture.history(&receipt), json!([]));
    }
}

#[test]
fn unicode_body_budget_counts_codepoints_and_old_apply_limit_is_unchanged() {
    let fixture = Fixture::new();
    let body = "😀".repeat(1200);
    let receipt = fixture.maintain(
        json!({"action":"refine","expected":fixture.snapshot(1),"content":body}),
        vec![],
    );
    assert_eq!(receipt["outcome"], "committed");
    assert_eq!(fixture.snapshot(1)["content"], body);
    let old_body = "x".repeat(1201);
    let old = fixture.invoke(&["organize", "apply", "--json"], &json!({"mode":"all","group":{"action":"refine","expected":fixture.snapshot(2),"content":old_body},"dependencies":[]}).to_string());
    assert_eq!(old["outcome"], "committed");
    assert_eq!(old["activity_status"], "not_requested");
    assert_eq!(fixture.snapshot(2)["content"], old_body);
}

#[test]
fn caller_is_validated_before_mutation_and_help_is_available() {
    let fixture = Fixture::new();
    let before = fixture.snapshot(1);
    let receipt = fixture.invoke(
        &[
            "organize",
            "maintain",
            "--json",
            "--caller-json",
            r#"{"actor":"","session_id":"session","message_id":"message"}"#,
        ],
        "",
    );
    assert_eq!(receipt["error"]["code"], "invalid_arguments");
    assert_eq!(fixture.snapshot(1), before);
    let help = fixture
        .command()
        .args(["organize", "maintain", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
}

#[test]
fn cross_placement_merge_is_rejected_and_configured_remote_never_falls_back() {
    let fixture = Fixture::new();
    fixture.connection.execute_batch("INSERT INTO domains VALUES('other','created'); UPDATE memories SET placement_kind='domain',domain_id='other' WHERE id=2;").unwrap();
    let source = fixture.invoke(
        &["organize", "read", "--json"],
        &json!({"keys":[{"id":2,"placement":"domain:other"}]}).to_string(),
    )["organization"]["records"][0]["snapshot"]
        .clone();
    let expected = fixture.snapshot(1);

    let receipt = fixture.maintain(
        json!({"action":"merge","survivor":expected,"sources":[source],"content":"replacement"}),
        vec![],
    );

    assert_eq!(receipt["error"]["code"], "invalid_request");
    assert_eq!(fixture.snapshot(1), expected);
    for variable in ["MEMOCAP_ADDR", "MEMOCAP_URL", "MEMOCAP_ADDRESS"] {
        let output = fixture
            .command()
            .env(variable, "http://127.0.0.1:1")
            .args(["organize", "maintain", "--json"])
            .output()
            .unwrap();
        let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(!output.status.success());
        assert_eq!(receipt["error"]["code"], "unsupported_backend");
    }
    assert_eq!(fixture.history(&receipt), json!([]));
}
