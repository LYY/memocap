use memocap::{activity::ActivityStore, inspection, scope::RepositoryId, store};
use rusqlite::{types::Value, Connection};

#[path = "schema_compatibility/malformed.rs"]
mod malformed;

fn repository() -> RepositoryId {
    format!("repository:{}", "a".repeat(64)).parse().unwrap()
}

fn version(connection: &Connection) -> (i64, i64) {
    connection
        .query_row("SELECT major,minor FROM schema_metadata", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap()
}

fn rows(connection: &Connection, table: &str) -> Vec<Vec<Value>> {
    let mut statement = connection
        .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
        .unwrap();
    let width = statement.column_count();
    statement
        .query_map([], |row| (0..width).map(|column| row.get(column)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn legacy(path: &std::path::Path) -> Connection {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(include_str!("fixtures/schema-1.0.sql"))
        .unwrap();
    connection
}

#[test]
fn new_store_has_activity_and_hints_in_the_same_main_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("core.db");

    let connection = store::open(&path).unwrap();

    assert_eq!(version(&connection), (2, 0));
    assert!(connection
        .prepare("SELECT sequence FROM activity_events")
        .is_ok());
    assert!(connection
        .prepare("SELECT repository_id FROM repository_metadata")
        .is_ok());
    assert_eq!(ActivityStore::open(&path).unwrap().path(), path);
    assert!(connection
        .prepare("SELECT * FROM activity_schema_metadata")
        .is_err());
}

#[test]
fn legacy_bridge_preserves_all_business_rows_and_search() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy.db");
    let connection = legacy(&path);
    connection.execute_batch("INSERT INTO domains VALUES('rust/cli','before');
      INSERT INTO repository_domain_attachments VALUES('repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','rust/cli',0);
      INSERT INTO memories(id,content,created_at,updated_at,placement_kind,domain_id) VALUES(41,'bridge searchable','before','before','domain','rust/cli');
      INSERT INTO memory_provenance VALUES(41,7,'universal',NULL,NULL,'copy','existing-operation','before','preserve note');
      INSERT INTO operation_ledger VALUES('existing-operation','repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','fingerprint','copy','{}','before');").unwrap();
    let tables = [
        "domains",
        "repository_domain_attachments",
        "memories",
        "memory_provenance",
        "operation_ledger",
    ];
    let before: Vec<_> = tables
        .iter()
        .map(|table| rows(&connection, table))
        .collect();
    drop(connection);

    let upgraded = store::open(&path).unwrap();

    assert_eq!(version(&upgraded), (2, 0));
    assert_eq!(
        tables
            .iter()
            .map(|table| rows(&upgraded, table))
            .collect::<Vec<_>>(),
        before
    );
    assert_eq!(
        upgraded
            .query_row(
                "SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'searchable'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        41
    );
}

#[test]
fn readonly_legacy_reports_upgrade_without_touching_new_tables() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy.db");
    drop(legacy(&path));
    let before = std::fs::read(&path).unwrap();

    let inspected = inspection::inspect(&path, &repository()).unwrap();

    assert_eq!(inspected.core_status, "upgrade_needed");
    assert_eq!(inspected.activity_status, "upgrade_needed");
    assert_eq!(inspected.schema_version.as_deref(), Some("1.0"));
    assert!(inspected.visible.is_none());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn future_minor_preserves_extensions_and_uses_defaults_for_baseline_inserts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("future.db");
    let connection = store::open(&path).unwrap();
    connection.execute_batch("ALTER TABLE memories ADD COLUMN future_label TEXT NOT NULL DEFAULT 'future-default';
      ALTER TABLE schema_metadata ADD COLUMN publisher TEXT DEFAULT 'future';
      CREATE TABLE future_links(memory_id INTEGER REFERENCES memories(id) ON DELETE CASCADE, label TEXT);
      CREATE INDEX future_label_index ON memories(future_label);
      CREATE TRIGGER future_link AFTER INSERT ON memories BEGIN INSERT INTO future_links VALUES(new.id,'linked'); END;
      UPDATE schema_metadata SET minor=7;").unwrap();
    drop(connection);

    let reopened = store::open(&path).unwrap();
    let id = store::remember(
        &reopened,
        "future baseline insert",
        "note",
        "",
        "global",
        true,
        None,
    )
    .unwrap();

    assert_eq!(version(&reopened), (2, 7));
    assert_eq!(
        reopened
            .query_row(
                "SELECT future_label FROM memories WHERE id=?1",
                [id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "future-default"
    );
    assert_eq!(
        reopened
            .query_row(
                "SELECT label FROM future_links WHERE memory_id=?1",
                [id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "linked"
    );
    assert_eq!(
        inspection::inspect(&path, &repository())
            .unwrap()
            .schema_version
            .as_deref(),
        Some("2.7")
    );
}

#[test]
fn explicit_activity_preparation_bridges_main_and_ignores_corrupt_old_auxiliary() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy.db");
    drop(legacy(&path));
    let auxiliary = directory.path().join("legacy.db.activity.sqlite");
    std::fs::write(&auxiliary, b"old auxiliary is opaque").unwrap();

    let prepared = ActivityStore::open(&path).unwrap();

    assert_eq!(prepared.path(), path);
    assert_eq!(version(&Connection::open(&path).unwrap()), (2, 0));
    assert_eq!(
        std::fs::read(auxiliary).unwrap(),
        b"old auxiliary is opaque"
    );
}
