use super::support::*;
use serde_json::json;

#[test]
fn commit_busy_confirms_full_rollback_and_retains_original_content() {
    let (_directory, path, connection) = database();
    let id = insert(&connection, "original before commit failure");
    let expected = snapshot(&path, id);
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; BEGIN; SELECT * FROM memories;").unwrap();

    let receipt = apply(
        &path,
        json!({"action":"refine","expected":expected,"content":"must roll back"}),
    );

    assert_eq!(receipt["error"]["code"], "database_error");
    assert_eq!(receipt["outcome"], "rolled_back");
    assert_eq!(snapshot(&path, id), expected);
}

#[test]
fn organization_does_not_prune_history_write_hints_or_append_activity() {
    let (_directory, path, connection) = database();
    let id = insert(&connection, "candidate");
    connection.execute_batch("INSERT INTO activity_events VALUES(1,'retained','recall','read',0,'before','{}');
        INSERT INTO repository_metadata VALUES('repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','retained','/gone','origin','before',0);").unwrap();
    let expected = snapshot(&path, id);
    let before = std::fs::read(&path).unwrap();
    let before_tables = tables(&connection);

    invoke(&path, "page", &json!({}));
    invoke(
        &path,
        "read",
        &json!({"keys":[{"id":id,"placement":"universal"}]}),
    );

    assert_eq!(std::fs::read(&path).unwrap(), before);
    apply(&path, json!({"action":"delete","expected":expected}));
    assert_eq!(tables(&connection), before_tables);
}

fn tables(connection: &rusqlite::Connection) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    ["activity_events", "repository_metadata", "operation_ledger"]
        .into_iter()
        .map(|table| {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let count = statement.column_count();
            statement
                .query_map([], |row| (0..count).map(|index| row.get(index)).collect())
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        })
        .collect()
}
