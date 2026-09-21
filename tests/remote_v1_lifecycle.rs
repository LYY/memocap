use std::path::Path;

use memocap::server;

const REPOSITORY: &str =
    "repository:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn dispatch(path: &str, body: serde_json::Value, database: &Path) -> serde_json::Value {
    let (status, response) = server::dispatch("POST", path, true, &body.to_string(), database);
    assert_eq!(status, 200, "response: {response}");
    serde_json::from_str(&response).unwrap()
}

fn remember(database: &Path, placement: &str, content: &str) -> i64 {
    dispatch(
        "/v1/memories/remember",
        serde_json::json!({
            "repository": REPOSITORY,
            "placement": placement,
            "content": content,
            "type": "note",
            "tags": "",
            "force": false,
            "id": null,
            "topic_key": null,
        }),
        database,
    )["id"]
        .as_i64()
        .unwrap()
}

#[test]
fn v1_memory_domains_visible_stack_and_status_match_local_placement_rules() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("memory.db");
    let domain = "engineering/rust";
    let repository_id = remember(&database, REPOSITORY, "repository memory");

    // When
    let created = dispatch(
        "/v1/domains/create",
        serde_json::json!({"repository": REPOSITORY, "domain": domain}),
        &database,
    );
    let attached = dispatch(
        "/v1/domains/attach",
        serde_json::json!({"repository": REPOSITORY, "domain": domain, "before": null}),
        &database,
    );
    let domain_id = remember(&database, "domain:engineering/rust", "domain memory");
    let universal_id = remember(&database, "universal", "universal memory");
    let recalled = dispatch(
        "/v1/memories/recall",
        serde_json::json!({
            "repository": REPOSITORY,
            "placement": null,
            "query": "memory",
            "limit": 20,
            "type": null,
            "max_chars": null,
        }),
        &database,
    );
    let listed = dispatch(
        "/v1/memories/list",
        serde_json::json!({"repository": REPOSITORY, "placement": null, "limit": 20}),
        &database,
    );
    let status = dispatch(
        "/v1/status",
        serde_json::json!({"repository": REPOSITORY}),
        &database,
    );
    let forgotten = dispatch(
        "/v1/memories/forget",
        serde_json::json!({
            "repository": REPOSITORY,
            "placement": "domain:engineering/rust",
            "id": domain_id,
        }),
        &database,
    );
    let detached = dispatch(
        "/v1/domains/detach",
        serde_json::json!({"repository": REPOSITORY, "domain": domain}),
        &database,
    );
    let deleted = dispatch(
        "/v1/domains/delete",
        serde_json::json!({"repository": REPOSITORY, "domain": domain}),
        &database,
    );

    // Then
    assert_eq!(created["changed"], true);
    assert_eq!(attached["changed"], true);
    assert_eq!(
        recalled["memories"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry["memory"]["id"].as_i64())
            .collect::<Vec<_>>(),
        vec![repository_id, domain_id, universal_id]
    );
    assert_eq!(listed["memories"].as_array().unwrap().len(), 3);
    assert_eq!(status["domains"], serde_json::json!([domain]));
    assert_eq!(status["status"]["addressable_total"], 3);
    assert_eq!(forgotten["deleted"], true);
    assert_eq!(detached["changed"], true);
    assert_eq!(deleted["changed"], true);
}
