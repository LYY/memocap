use super::*;

fn transfer(source: i64, key: &str) -> Value {
    json!({"operation":"transfer","action":"copy","id":source,"from":"universal","to":REPO,"idempotency_key":key,"note":null})
}

#[test]
fn destination_identity_failure_rolls_back_memory_provenance_and_ledger() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.db");
    let connection = store::open(&path).unwrap();
    let source = store::remember(&connection, "source", "note", "", "global", true, None).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_identity BEFORE INSERT ON repository_identities BEGIN SELECT RAISE(ABORT,'identity unavailable'); END;").unwrap();
    let input = request(
        transfer(source, "00000000-0000-0000-0000-000000000721"),
        descriptor("destination", None),
    );
    // When
    let (status, _) = server::dispatch("POST", "/v1/receipt", true, &input.to_string(), &path);
    // Then
    assert_eq!(status, 400);
    for (table, expected) in [
        ("memories", 1),
        ("memory_provenance", 0),
        ("operation_ledger", 0),
    ] {
        assert_eq!(
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            expected
        );
    }
}

#[test]
fn committed_replay_never_enriches_identity_or_location() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.db");
    let connection = store::open(&path).unwrap();
    let source = store::remember(&connection, "source", "note", "", "global", true, None).unwrap();
    let command = transfer(source, "00000000-0000-0000-0000-000000000722");
    let first = execute(&path, &request(command.clone(), Value::Null));
    let mut input = request(
        command,
        descriptor("must not register", Some("host/team/new")),
    );
    input["targets"][0]["observed_at"] = json!("2026-10-30T10:00:00Z");
    input["targets"][0]["canonical_path"] = json!("/other/client/path");
    // When
    let replay = execute(&path, &input);
    // Then
    assert_eq!(replay["returned_ids"], first["returned_ids"]);
    assert_eq!(replay["repository_context"], first["repository_context"]);
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn location_failure_reports_warning_after_memory_and_identity_commit() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.db");
    let connection = store::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_location BEFORE INSERT ON repository_locations BEGIN SELECT RAISE(ABORT,'location unavailable'); END;").unwrap();
    // When
    let receipt = execute(&path, &request(remember(None), descriptor("known", None)));
    // Then
    assert_eq!(receipt["status"], "inserted");
    assert!(receipt["warning"].as_str().unwrap().contains("location"));
    assert_eq!(
        receipt["repository_context"][REPO]["identity"]["display_name"],
        "known"
    );
    assert_eq!(receipt["repository_context"][REPO]["locations"], json!([]));
}

#[test]
fn delete_does_not_register_identity_or_location() {
    // Given
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.db");
    let connection = store::open(&path).unwrap();
    let id = store::remember(&connection, "delete", "note", "", REPO, true, None).unwrap();
    // When
    let receipt = execute(
        &path,
        &request(
            json!({"operation":"forget","id":id,"placement":null}),
            descriptor("unused", None),
        ),
    );
    // Then
    assert_eq!(receipt["status"], "deleted");
    assert_eq!(
        receipt["repository_context"][REPO],
        json!({"identity":null,"locations":[]})
    );
}
