use memocap::{server, store};
use rusqlite::Connection;
use serde_json::{json, Value};

#[path = "support/observable.rs"]
mod observable;
#[path = "repository_identity/remote.rs"]
mod remote;
#[path = "repository_identity/targets.rs"]
mod targets;
#[path = "repository_identity/transfers.rs"]
mod transfers;

const REPO: &str = "repository:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn descriptor(name: &str, remote: Option<&str>) -> Value {
    json!({"display_name":name,"name_source":"remote","origin":"local","normalized_remote":remote})
}

fn request(command: Value, descriptor: Value) -> Value {
    json!({"operation_id":"00000000-0000-0000-0000-000000000711",
        "targets":[{"repository_id":REPO,"canonical_path":"/client/nonexistent/checkout",
            "identity_source":"git-config","placements":[REPO],"descriptor":descriptor,
            "observed_at":"2026-10-29T10:00:00Z"}],
        "command":command,"caller":{"actor":"cli","session_id":null,"message_id":null}})
}

fn remember(id: Option<i64>) -> Value {
    json!({"operation":"remember","content":"durable identity memory","kind":"note",
        "tags":"identity","topic":null,"force":true,"id":id,"placement":null})
}

fn execute(path: &std::path::Path, input: &Value) -> Value {
    let (status, body) = server::dispatch("POST", "/v1/receipt", true, &input.to_string(), path);
    assert_eq!(status, 200, "{body}");
    serde_json::from_str(&body).unwrap()
}

#[test]
fn remote_identity_is_atomic_and_executor_assigns_origin() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.db");
    // When
    let receipt = execute(
        &path,
        &request(
            remember(None),
            descriptor("team/project", Some("host/team/project")),
        ),
    );
    // Then
    assert_eq!(receipt["status"], "inserted");
    assert_eq!(
        receipt["repository_context"][REPO]["identity"]["display_name"],
        "team/project"
    );
    assert_eq!(
        receipt["repository_context"][REPO]["identity"]["origin"],
        "client_reported"
    );
    assert_eq!(
        receipt["repository_context"][REPO]["locations"][0]["canonical_path"],
        "/client/nonexistent/checkout"
    );
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM repository_metadata", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn identity_failure_rolls_back_insert_and_overwrite() {
    for overwrite in [false, true] {
        // Given
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("core.db");
        let connection = store::open(&path).unwrap();
        let id = store::remember(&connection, "before", "note", "", REPO, true, None).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_identity BEFORE INSERT ON repository_identities BEGIN SELECT RAISE(ABORT,'identity unavailable'); END;").unwrap();
        let input = request(
            remember(overwrite.then_some(id)),
            descriptor("project", None),
        );
        // When
        let (status, _) = server::dispatch("POST", "/v1/receipt", true, &input.to_string(), &path);
        // Then
        assert_eq!(status, 400);
        assert_eq!(
            connection
                .query_row("SELECT content FROM memories WHERE id=?1", [id], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "before"
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM memories", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

#[test]
fn first_identity_is_immutable_while_missing_remote_is_filled() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.db");
    let first = execute(&path, &request(remember(None), descriptor("first", None)));
    // When
    let second = execute(
        &path,
        &request(remember(None), descriptor("renamed", Some("host/renamed"))),
    );
    // Then
    let identity = &second["repository_context"][REPO]["identity"];
    assert_eq!(identity["display_name"], "first");
    assert_eq!(identity["normalized_remote"], "host/renamed");
    assert_eq!(
        identity["recorded_at"],
        first["repository_context"][REPO]["identity"]["recorded_at"]
    );
}

#[test]
fn id_only_cli_remains_usable_after_checkout_is_deleted() {
    // Given
    let fixture = observable::Fixture::new();
    let resolved = fixture.json(
        &[
            "--json",
            "--repo",
            fixture.b.to_str().unwrap(),
            "scope",
            "resolve",
        ],
        true,
    );
    let repository = resolved["targets"][0]["repository_id"].as_str().unwrap();
    std::fs::remove_dir(&fixture.b).unwrap();
    // When
    let saved = fixture.json(
        &[
            "--json",
            "--repository-id",
            repository,
            "remember",
            "pathless durable memory",
        ],
        true,
    );
    let recalled = fixture.json(
        &[
            "--json",
            "--repository-id",
            repository,
            "recall",
            "pathless",
        ],
        true,
    );
    // Then
    assert_eq!(saved["targets"][0]["canonical_path"], Value::Null);
    assert_eq!(
        recalled["results"][0]["memory"]["content"],
        "pathless durable memory"
    );
    assert_eq!(
        recalled["repository_context"][repository]["identity"],
        Value::Null
    );
    assert_eq!(
        recalled["repository_context"][repository]["locations"],
        json!([])
    );
}

#[test]
fn pure_resolution_does_not_initialize_database() {
    // Given
    let fixture = observable::Fixture::new();
    // When
    let receipt = fixture.json(
        &[
            "--json",
            "--repo",
            fixture.b.to_str().unwrap(),
            "scope",
            "resolve",
        ],
        true,
    );
    // Then
    assert_eq!(receipt["operation"], "scope_resolve");
    assert_eq!(receipt["targets"][0]["descriptor"]["display_name"], "b");
    assert_eq!(
        receipt["targets"][0]["descriptor"]["name_source"],
        "directory"
    );
    assert!(!fixture.database.exists());
}
