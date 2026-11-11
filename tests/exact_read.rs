use memocap::{activity::ActivityBackend, operation, scope::PlacementId, store};
use serde_json::json;

#[path = "support/observable.rs"]
mod observable;

const CONTEXT: &str = "repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORIGIN: &str = "repository:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn request(id: i64, placement: &str) -> operation::Request {
    serde_json::from_value(json!({
        "operation_id": "00000000-0000-0000-0000-000000000611",
        "targets": [{"repository_id": CONTEXT, "canonical_path": null,
            "identity_source": "explicit", "placements": [CONTEXT]}],
        "command": {"operation": "read", "id": id, "placement": placement}
    }))
    .unwrap()
}

#[test]
fn exact_read_returns_the_full_current_origin_record_with_another_context() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memory.db");
    let connection = store::open(&database).unwrap();
    let placement: PlacementId = ORIGIN.parse().unwrap();
    let content = format!(
        "{}\n尾部约束: do not execute in production.\n\"quoted\"\\",
        "完整 memory 🦀 ".repeat(700)
    );
    let id = store::remember_at(
        &connection,
        &placement,
        &content,
        "note",
        "readback",
        store::RememberOptions {
            topic_key: Some("exact-read"),
            force: true,
            overwrite_id: None,
        },
    )
    .unwrap();
    let expected = store::memory_by_id(&connection, id).unwrap().unwrap();

    let receipt = operation::execute(&database, &request(id, ORIGIN), ActivityBackend::Local);

    assert!(receipt.succeeded(), "{:?}", receipt.error);
    assert_eq!(receipt.operation, "read");
    assert_eq!(receipt.returned_ids, vec![id]);
    assert_eq!(receipt.searched_placements, vec![ORIGIN]);
    assert_eq!(receipt.results.len(), 1);
    assert_eq!(receipt.results[0].memory, expected);
    assert!(receipt.results[0].applicable_repositories.is_empty());
    assert_eq!(
        serde_json::to_value(&receipt).unwrap()["results"][0]["applicability"],
        "unknown"
    );
    assert_eq!(receipt.targets[0].repository_id.to_string(), CONTEXT);
    assert!(!receipt.truncated);
    assert_eq!(receipt.activity_status, "not_requested");
    assert!(serde_json::to_value(receipt).unwrap()["repository_context"][ORIGIN].is_object());
}

#[test]
fn exact_read_returns_empty_for_missing_id_or_mismatched_placement() {
    let fixture = observable::Fixture::new();
    let connection = store::open(&fixture.database).unwrap();
    let id = store::remember_at(
        &connection,
        &ORIGIN.parse().unwrap(),
        "origin only",
        "note",
        "",
        store::RememberOptions {
            topic_key: None,
            force: true,
            overwrite_id: None,
        },
    )
    .unwrap();

    for (selected_id, placement) in [(id + 1, ORIGIN), (id, CONTEXT), (id, "universal")] {
        let receipt = operation::execute(
            &fixture.database,
            &request(selected_id, placement),
            ActivityBackend::Local,
        );

        assert_eq!(receipt.status, memocap::receipt::Status::Empty);
        assert!(receipt.results.is_empty());
        assert!(receipt.returned_ids.is_empty());
        assert!(receipt.matched_ids.is_empty());
        assert_eq!(receipt.searched_placements, [placement]);
        assert!(!receipt.truncated);
    }
}

#[test]
fn exact_read_rejects_nonpositive_ids_and_invalid_context_counts_before_opening() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("must-not-exist.db");
    let mut empty_context = request(1, ORIGIN);
    empty_context.targets.clear();
    let mut two_contexts = request(1, ORIGIN);
    two_contexts.targets.push(two_contexts.targets[0].clone());

    for input in [
        request(0, ORIGIN),
        request(-1, ORIGIN),
        empty_context,
        two_contexts,
    ] {
        let receipt = operation::execute(&database, &input, ActivityBackend::Local);

        assert_eq!(receipt.status, memocap::receipt::Status::Failed);
        assert!(receipt.results.is_empty());
        assert!(!database.exists());
    }
}

#[test]
fn exact_read_wire_requires_a_valid_explicit_placement() {
    let valid = serde_json::to_value(request(1, ORIGIN)).unwrap();
    for placement in [json!(null), json!(""), json!("repository:invalid")] {
        let mut input = valid.clone();
        input["command"]["placement"] = placement;

        assert!(serde_json::from_value::<operation::Request>(input).is_err());
    }
    let mut missing = valid;
    missing["command"]
        .as_object_mut()
        .unwrap()
        .remove("placement");
    assert!(serde_json::from_value::<operation::Request>(missing).is_err());
}

#[test]
fn local_cli_reads_the_same_full_body_in_json_and_plaintext() {
    let fixture = observable::Fixture::new();
    let connection = store::open(&fixture.database).unwrap();
    let content = format!(
        "{}\n尾部: never use in production.",
        "readback 🦀 \"quoted\" ".repeat(500)
    );
    let id = store::remember_at(
        &connection,
        &ORIGIN.parse().unwrap(),
        &content,
        "note",
        "",
        store::RememberOptions {
            topic_key: None,
            force: true,
            overwrite_id: None,
        },
    )
    .unwrap();
    let id_text = id.to_string();
    let args = [
        "--repository-id",
        CONTEXT,
        "read",
        &id_text,
        "--placement",
        ORIGIN,
    ];

    let mut json_args = args.to_vec();
    json_args.push("--json");
    let receipt = fixture.json(&json_args, true);
    let output = fixture
        .command(&args)
        .current_dir(&fixture.b)
        .output()
        .unwrap();

    assert_eq!(receipt["results"][0]["memory"]["content"], content);
    assert_eq!(receipt["returned_ids"], json!([id]));
    assert_eq!(receipt["results"][0]["applicability"], "unknown");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let plaintext = String::from_utf8(output.stdout).unwrap();
    assert!(plaintext.contains(&content));
    assert!(plaintext.contains(&format!("placement: {ORIGIN}")));
    assert!(plaintext.contains("applicability: unknown"));
}

#[test]
fn local_cli_reports_empty_for_a_wrong_origin_and_rejects_a_missing_placement() {
    let fixture = observable::Fixture::new();
    let connection = store::open(&fixture.database).unwrap();
    let id = store::remember_at(
        &connection,
        &ORIGIN.parse().unwrap(),
        "must stay in origin",
        "note",
        "",
        store::RememberOptions {
            topic_key: None,
            force: true,
            overwrite_id: None,
        },
    )
    .unwrap();

    let mismatch = fixture.json(
        &[
            "--json",
            "--repository-id",
            CONTEXT,
            "read",
            &id.to_string(),
            "--placement",
            CONTEXT,
        ],
        true,
    );
    let missing = fixture.json(
        &[
            "--json",
            "--repository-id",
            CONTEXT,
            "read",
            &id.to_string(),
        ],
        false,
    );

    assert_eq!(mismatch["status"], "empty");
    assert_eq!(mismatch["results"], json!([]));
    assert_eq!(mismatch["returned_ids"], json!([]));
    assert_eq!(missing["error"]["code"], "invalid_arguments");
}
