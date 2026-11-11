use super::*;

fn snapshot(connection: &Connection) -> Vec<(String, Vec<Vec<Value>>)> {
    let tables = connection
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name<>'schema_metadata' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    tables
        .into_iter()
        .map(|table| {
            let quoted = table.replace('"', "\"\"");
            let mut statement = connection
                .prepare(&format!("SELECT * FROM \"{quoted}\""))
                .unwrap();
            let width = statement.column_count();
            let order = (1..=width)
                .map(|column| column.to_string())
                .collect::<Vec<_>>()
                .join(",");
            statement = connection
                .prepare(&format!("SELECT * FROM \"{quoted}\" ORDER BY {order}"))
                .unwrap();
            let contents = statement
                .query_map([], |row| (0..width).map(|column| row.get(column)).collect())
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            (table, contents)
        })
        .collect()
}

fn objects(connection: &Connection) -> Vec<(String, String)> {
    connection.prepare("SELECT name,coalesce(sql,'') FROM sqlite_schema WHERE name NOT IN ('activity_events','activity_retention') ORDER BY name")
        .unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

#[test]
fn migration_preserves_every_table_and_unrelated_extension_object_without_pruning() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("prior.db");
    let connection = current_fixture(&path);
    connection.execute_batch("ALTER TABLE memories ADD COLUMN extension BLOB;
        CREATE TABLE extension_rows(memory_id INTEGER REFERENCES memories(id), opaque BLOB);
        CREATE INDEX extension_index ON extension_rows(memory_id);
        CREATE VIEW extension_view AS SELECT opaque FROM extension_rows;
        CREATE TRIGGER extension_trigger AFTER INSERT ON extension_rows BEGIN SELECT 1; END;
        INSERT INTO domains VALUES('rust/cli','domain-time');
        INSERT INTO repository_domain_attachments VALUES('repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','rust/cli',0);
        INSERT INTO memories VALUES(41,'searchable domain memory','decision','rust','created','updated','global','topic','domain',NULL,'rust/cli','organized',X'00FF');
        INSERT INTO memories VALUES(97,'repository memory','note','cli','created2','updated2','local','','repository','repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',NULL,NULL,X'01');
        INSERT INTO memories VALUES(103,'universal memory','context','','created3','updated3','global','','universal',NULL,NULL,NULL,NULL);
        INSERT INTO extension_rows VALUES(41,X'FF00');
        INSERT INTO memory_provenance VALUES(41,7,'universal',NULL,NULL,'copy','existing-operation','before','preserve note');
        INSERT INTO operation_ledger VALUES('existing-operation','repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','fingerprint','copy','{\"opaque\":true}','before');
        INSERT INTO repository_metadata VALUES('repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','hint','/vanished','origin','before',0);
        INSERT INTO repository_identities VALUES('repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','name','remote','origin','remote','identity-time');
        INSERT INTO repository_locations VALUES('repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','/vanished','observed','local');
        INSERT INTO activity_events VALUES(3,'history','write','write',0,'original-time',' { \"opaque\": true } ');
        INSERT INTO activity_events VALUES(801,'history','recall','read',0,'expired-time','{\"unknown\":[1,2]}');").unwrap();
    let before = snapshot(&connection);
    let definitions = objects(&connection);
    drop(connection);

    let (upgraded, lifecycle) = store::open_with_lifecycle(&path).unwrap();

    assert_eq!(lifecycle, store::SchemaLifecycle::Upgraded);
    assert_eq!(version(&upgraded), (2, 3));
    assert_eq!(snapshot(&upgraded), before);
    assert_eq!(objects(&upgraded), definitions);
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
    assert!(upgraded.execute("INSERT INTO activity_events SELECT 802,operation_id,phase,category,started_at_ms,recorded_at,event_json FROM activity_events WHERE sequence=3", []).is_err());
    upgraded.execute("INSERT INTO activity_events(operation_id,phase,category,started_at_ms,recorded_at,event_json) VALUES('next','capture_review','read',1,'after','{}')", []).unwrap();
    assert_eq!(upgraded.last_insert_rowid(), 802);
}

#[test]
fn readonly_prior_preserves_expired_history_and_all_schema_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("prior.db");
    let connection = current_fixture(&path);
    connection
        .execute(
            "INSERT INTO activity_events VALUES(901,'expired','recall','read',0,'before','{}')",
            [],
        )
        .unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();

    let status = inspection::inspect(&path, &repository()).unwrap();

    assert_eq!(status.core_status, "upgrade_needed");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(ActivityStore::open_readonly(&path).is_err());
    assert_eq!(
        rows(&Connection::open(&path).unwrap(), "activity_events")[0][0],
        Value::Integer(901)
    );
}

#[test]
fn dependent_extensions_refuse_before_any_schema_mutation() {
    for extension in [
        "ALTER TABLE activity_events ADD COLUMN opaque TEXT",
        "CREATE INDEX extension_index ON activity_events(recorded_at)",
        "CREATE TRIGGER extension_trigger AFTER DELETE ON activity_events BEGIN SELECT 1; END",
        "CREATE VIEW extension_view AS SELECT * FROM activity_events",
        "CREATE TABLE extension_rows(event INTEGER REFERENCES activity_events(sequence) ON DELETE CASCADE)",
        "CREATE TRIGGER extension_trigger AFTER INSERT ON memories BEGIN SELECT sequence FROM activity_events; END",
        "CREATE TABLE activity_events_v23(opaque TEXT)",
        "CREATE TABLE ACTIVITY_EVENTS_V23(opaque TEXT)",
        "CREATE TRIGGER extension_trigger AFTER UPDATE ON schema_metadata BEGIN DELETE FROM memories; END",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("prior.db");
        let connection = current_fixture(&path);
        connection.execute_batch(extension).unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();

        assert!(store::open(&path).is_err(), "{extension}");

        assert_eq!(std::fs::read(&path).unwrap(), before, "{extension}");
    }
}
