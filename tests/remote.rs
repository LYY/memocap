use std::path::Path;

use memocap::server;

const REPOSITORY: &str =
    "repository:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn remember_body(content: &str) -> String {
    serde_json::json!({
        "repository": REPOSITORY,
        "placement": REPOSITORY,
        "content": content,
        "type": "note",
        "tags": "",
        "force": false,
        "id": null,
        "topic_key": null,
    })
    .to_string()
}

fn dispatch(path: &str, body: &str, database: &Path) -> (u16, String) {
    server::dispatch("POST", path, true, body, database)
}

#[test]
fn v1_routes_replace_unversioned_transport_before_store_open() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memory.db");
    let body = remember_body("remote v1 memory");

    // When
    let legacy = dispatch("/remember", &body, &database);
    let legacy_created_store = database.exists();
    let versioned = dispatch("/v1/memories/remember", &body, &database);

    // Then
    assert_eq!(legacy.0, 404);
    assert_eq!(legacy.1, r#"{"error":"not_found"}"#);
    assert!(!legacy_created_store);
    assert_eq!(versioned.0, 200);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&versioned.1).unwrap()["id"].as_i64(),
        Some(1)
    );
}

#[test]
fn v1_rejects_malformed_repository_and_placement_without_creating_store() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memory.db");
    let invalid_repository = serde_json::json!({
        "repository": "repository:bad",
        "placement": "universal",
        "content": "must not persist",
        "type": "note",
        "tags": "",
        "force": false,
        "id": null,
        "topic_key": null,
    })
    .to_string();
    let invalid_placement = serde_json::json!({
        "repository": REPOSITORY,
        "placement": "domain:../../escape",
        "content": "must not persist",
        "type": "note",
        "tags": "",
        "force": false,
        "id": null,
        "topic_key": null,
    })
    .to_string();

    // When
    let malformed_repository = dispatch("/v1/memories/remember", &invalid_repository, &database);
    let malformed_placement = dispatch("/v1/memories/remember", &invalid_placement, &database);

    // Then
    assert_eq!(malformed_repository.0, 400);
    assert_eq!(malformed_placement.0, 400);
    assert_eq!(malformed_repository.1, r#"{"error":"invalid_request"}"#);
    assert_eq!(malformed_placement.1, r#"{"error":"invalid_request"}"#);
    assert!(!database.exists());
}
