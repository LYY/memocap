use crate::support::*;
use serde_json::json;

#[test]
fn ignored_merge_source_delete_rolls_back_the_entire_group() {
    let (_directory, path, connection) = database();
    for content in ["original survivor", "first source", "ignored source"] {
        insert(&connection, content);
    }
    connection.execute_batch("INSERT INTO memory_provenance VALUES(2,8,'universal',NULL,NULL,'copy','op','created',NULL);
        CREATE TRIGGER ignore_source BEFORE DELETE ON memories WHEN old.id=3 BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    let originals: Vec<_> = (1..=3).map(|id| snapshot(&path, id)).collect();

    let receipt = apply(
        &path,
        json!({"action":"merge","survivor":originals[0],"sources":[originals[1],originals[2]],"content":"replacement"}),
    );

    let actual: Vec<_> = (1..=3).map(|id| snapshot(&path, id)).collect();
    assert_eq!(
        receipt["status"], "failed",
        "{receipt}; snapshots: {actual:?}"
    );
    assert_eq!(receipt["error"]["code"], "database_error");
    assert_eq!(receipt["outcome"], "rolled_back");
    assert_eq!(actual, originals);
    let mut statement = connection.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'survivor OR source' ORDER BY rowid").unwrap();
    let matching: Vec<i64> = statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(matching, [1, 2, 3]);
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
fn ignored_keep_update_reports_database_error_without_marking() {
    let (_directory, path, connection) = database();
    let id = insert(&connection, "original");
    connection
        .execute_batch(
            "CREATE TRIGGER ignore_keep BEFORE UPDATE ON memories BEGIN SELECT RAISE(IGNORE); END;",
        )
        .unwrap();
    let original = snapshot(&path, id);

    let receipt = apply(&path, json!({"action":"keep","expected":original}));

    assert_eq!(receipt["status"], "failed", "{receipt}");
    assert_eq!(receipt["error"]["code"], "database_error");
    assert_eq!(receipt["outcome"], "rolled_back");
    assert_eq!(snapshot(&path, id), original);
}

#[test]
fn ignored_refine_update_reports_database_error_without_rewriting() {
    let (_directory, path, connection) = database();
    let id = insert(&connection, "original");
    connection.execute_batch("CREATE TRIGGER ignore_refine BEFORE UPDATE ON memories BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    let original = snapshot(&path, id);

    let receipt = apply(
        &path,
        json!({"action":"refine","expected":original,"content":"replacement"}),
    );

    assert_eq!(receipt["status"], "failed", "{receipt}");
    assert_eq!(receipt["error"]["code"], "database_error");
    assert_eq!(receipt["outcome"], "rolled_back");
    assert_eq!(snapshot(&path, id), original);
}

#[test]
fn ignored_delete_reports_database_error_without_removing_memory() {
    let (_directory, path, connection) = database();
    let id = insert(&connection, "original");
    connection.execute_batch("CREATE TRIGGER ignore_delete BEFORE DELETE ON memories BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    let original = snapshot(&path, id);

    let receipt = apply(&path, json!({"action":"delete","expected":original}));

    assert_eq!(receipt["status"], "failed", "{receipt}");
    assert_eq!(receipt["error"]["code"], "database_error");
    assert_eq!(receipt["outcome"], "rolled_back");
    assert_eq!(snapshot(&path, id), original);
}
