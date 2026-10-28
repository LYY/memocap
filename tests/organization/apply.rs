use super::support::*;
use serde_json::json;

#[path = "ignored.rs"]
mod ignored;

#[test]
fn keep_only_marks_and_refine_preserves_survivor_metadata() {
    let (_directory, path, connection) = database();
    let id = insert(&connection, "precise original");
    let original = snapshot(&path, id);
    let kept = apply(&path, json!({"action":"keep","expected":original}));
    assert_eq!(kept["outcome"], "committed");
    let marked = &kept["organization"]["records"][0];
    assert_eq!(marked["updated_at"], "updated");
    assert!(marked["organized_at"].is_string());
    let refusal = apply(&path, json!({"action":"delete","expected":marked}));
    assert_eq!(refusal["error"]["code"], "mode_violation");
    let refined = invoke(
        &path,
        "apply",
        &json!({"mode":"all","group":{"action":"refine","expected":marked,"content":"  approved exact text\n"},"dependencies":[]}),
    );
    assert_eq!(
        refined["organization"]["records"][0]["content"],
        "  approved exact text\n"
    );
    assert_eq!(snapshot(&path, id)["created_at"], "created");
}

#[test]
fn stale_participant_or_dependency_rejects_whole_group() {
    for mutation in ["UPDATE memories SET tags='changed' WHERE id=1", "UPDATE memories SET content='changed reference' WHERE id=2", "INSERT INTO memory_provenance VALUES(1,8,'universal',NULL,NULL,'copy','op','created',NULL)"] {
        let (_directory, path, connection) = database();
        insert(&connection, "candidate");
        insert(&connection, "reference");
        let candidate = snapshot(&path, 1);
        let reference = snapshot(&path, 2);
        connection.execute_batch(mutation).unwrap();
        let receipt = invoke(&path, "apply", &json!({"mode":"pending","group":{"action":"delete","expected":candidate},"dependencies":[reference]}));
        assert_eq!(receipt["status"], "rejected");
        assert_eq!(receipt["outcome"], "rolled_back");
        assert_eq!(receipt["error"]["code"], "snapshot_conflict");
        assert!(snapshot(&path, 1)["organized_at"].is_null());
    }
}

#[test]
fn stale_merge_source_rejects_before_rewriting_survivor() {
    let (_directory, path, connection) = database();
    insert(&connection, "survivor");
    insert(&connection, "source");
    let survivor = snapshot(&path, 1);
    let source = snapshot(&path, 2);
    connection
        .execute(
            "UPDATE memories SET content='changed source' WHERE id=2",
            [],
        )
        .unwrap();

    let receipt = apply(
        &path,
        json!({"action":"merge","survivor":survivor,"sources":[source],"content":"replacement"}),
    );

    assert_eq!(receipt["error"]["code"], "snapshot_conflict");
    assert_eq!(snapshot(&path, 1), survivor);
    assert_eq!(snapshot(&path, 2)["content"], "changed source");
}

#[test]
fn organized_dependency_in_other_placement_remains_readonly_in_pending_mode() {
    let (_directory, path, connection) = database();
    insert(&connection, "candidate");
    insert(&connection, "reference");
    connection.execute_batch("INSERT INTO domains VALUES('reference','created'); UPDATE memories SET placement_kind='domain',domain_id='reference',organized_at='organized' WHERE id=2;").unwrap();
    let candidate = snapshot(&path, 1);
    let reference = invoke(
        &path,
        "read",
        &json!({"keys":[{"id":2,"placement":"domain:reference"}]}),
    )["organization"]["records"][0]["snapshot"]
        .clone();

    let receipt = invoke(
        &path,
        "apply",
        &json!({"mode":"pending","group":{"action":"keep","expected":candidate},"dependencies":[reference]}),
    );

    assert_eq!(receipt["outcome"], "committed");
    assert_eq!(
        invoke(
            &path,
            "read",
            &json!({"keys":[{"id":2,"placement":"domain:reference"}]})
        )["organization"]["records"][0]["snapshot"],
        reference
    );
}

#[test]
fn merge_failure_rolls_back_content_mark_deletions_provenance_and_fts() {
    let (_directory, path, connection) = database();
    for text in ["original survivor", "first source", "failure source"] {
        insert(&connection, text);
    }
    connection.execute_batch("INSERT INTO memory_provenance VALUES(2,8,'universal',NULL,NULL,'copy','op','created',NULL);
        CREATE TRIGGER fail_merge BEFORE DELETE ON memories WHEN old.id=3 BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    let originals: Vec<_> = (1..=3).map(|id| snapshot(&path, id)).collect();
    let receipt = apply(
        &path,
        json!({"action":"merge","survivor":originals[0],"sources":[originals[1],originals[2]],"content":"merged replacement"}),
    );
    assert_eq!(receipt["error"]["code"], "database_error");
    assert_eq!(receipt["outcome"], "rolled_back");
    for id in 1..=3 {
        assert_eq!(
            snapshot(&path, id),
            originals[usize::try_from(id - 1).unwrap()]
        );
    }
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM memories_fts WHERE memories_fts MATCH 'original OR source'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        3
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT count(*) FROM memories_fts WHERE memories_fts MATCH 'replacement'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[test]
fn sqlite_automatic_rollback_is_reported_as_confirmed_rollback() {
    let (_directory, path, connection) = database();
    insert(&connection, "survivor");
    insert(&connection, "source");
    connection.execute_batch("CREATE TRIGGER fail_merge BEFORE DELETE ON memories BEGIN SELECT RAISE(ROLLBACK,'injected rollback'); END;").unwrap();
    let survivor = snapshot(&path, 1);
    let source = snapshot(&path, 2);

    let receipt = apply(
        &path,
        json!({"action":"merge","survivor":survivor,"sources":[source],"content":"replacement"}),
    );

    assert_eq!(receipt["outcome"], "rolled_back");
    assert_eq!(snapshot(&path, 1), survivor);
    assert_eq!(snapshot(&path, 2), source);
}

#[test]
fn merge_preserves_survivor_extensions_and_delete_cascades_provenance() {
    let (_directory, path, connection) = database();
    for text in ["survivor", "source"] {
        insert(&connection, text);
    }
    connection.execute_batch("ALTER TABLE memories ADD COLUMN extra TEXT DEFAULT 'preserved';
        INSERT INTO memory_provenance VALUES(1,8,'universal',NULL,NULL,'copy','op','created',NULL);
        INSERT INTO memory_provenance VALUES(2,9,'universal',NULL,NULL,'copy','source-op','created',NULL);").unwrap();
    let survivor = snapshot(&path, 1);
    let source = snapshot(&path, 2);
    let receipt = apply(
        &path,
        json!({"action":"merge","survivor":survivor,"sources":[source],"content":"merged exact"}),
    );
    assert_eq!(receipt["outcome"], "committed");
    assert_eq!(
        receipt["organization"]["deleted"],
        json!([{"id":2,"placement":"universal"}])
    );
    assert_eq!(snapshot(&path, 1)["provenance"], survivor["provenance"]);
    assert!(snapshot(&path, 2).is_null());
    assert_eq!(
        connection
            .query_row("SELECT extra FROM memories WHERE id=1", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "preserved"
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM memory_provenance", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
