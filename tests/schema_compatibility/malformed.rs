use memocap::store;

#[test]
fn required_future_column_with_parenthesized_null_default_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("invalid-default.db");
    let connection = store::open(&path).unwrap();
    connection.execute_batch("ALTER TABLE memories ADD COLUMN future TEXT NOT NULL DEFAULT (NULL); UPDATE schema_metadata SET minor=8;").unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();

    let opened = store::open(&path);

    assert!(opened.is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn altered_known_definitions_refuse_even_when_comments_quote_expected_checks() {
    for (table, from, to) in [
        (
            "repository_domain_attachments",
            "CHECK (position >= 0)",
            "CHECK (1) /* CHECK (position >= 0) */",
        ),
        (
            "memories",
            "CHECK (placement_kind IN ('repository', 'domain', 'universal'))",
            "CHECK (1 OR placement_kind IN ('repository', 'domain', 'universal'))",
        ),
        ("memories", "ON DELETE RESTRICT", "ON DELETE CASCADE"),
        ("memories", "content TEXT NOT NULL", "content BLOB NOT NULL"),
        ("memories", "DEFAULT 'context'", "DEFAULT 'changed'"),
        (
            "repository_metadata",
            "last_seen TEXT NOT NULL",
            "last_seen TEXT",
        ),
        ("memories_au", "AFTER UPDATE", "BEFORE UPDATE"),
        (
            "memories_fts",
            "content_rowid='id'",
            "content_rowid='rowid'",
        ),
        (
            "activity_retention",
            "started_at_ms DESC",
            "started_at_ms ASC",
        ),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("malformed.db");
        let connection = store::open(&path).unwrap();
        let original: String = connection
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name=?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert!(original.contains(from));
        connection
            .execute_batch("PRAGMA writable_schema=ON;")
            .unwrap();
        connection
            .execute(
                "UPDATE sqlite_schema SET sql=?1 WHERE name=?2",
                rusqlite::params![original.replace(from, to), table],
            )
            .unwrap();
        connection
            .execute_batch("PRAGMA writable_schema=OFF;")
            .unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();

        assert!(store::open(&path).is_err(), "{table}: {from}");

        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[test]
fn extra_unique_indexes_and_constraints_refuse_without_mutation() {
    for mutation in [
        "CREATE UNIQUE INDEX tighter_content ON memories(content)",
        "CREATE UNIQUE INDEX tighter_shadow ON memories_fts_config(v)",
        "ALTER TABLE memories ADD COLUMN future TEXT CHECK(content <> 'rejected')",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tightened.db");
        let connection = store::open(&path).unwrap();
        connection.execute_batch(mutation).unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();

        assert!(store::open(&path).is_err(), "{mutation}");

        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[test]
fn organized_column_requires_exact_nullable_text_null_default_on_schema_2_1() {
    for definition in [
        None,
        Some("organized_at BLOB DEFAULT NULL"),
        Some("organized_at TEXT NOT NULL DEFAULT ''"),
        Some("organized_at TEXT DEFAULT 'done'"),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("malformed.db");
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(include_str!("../fixtures/schema-2.0.sql"))
            .unwrap();
        if let Some(definition) = definition {
            connection
                .execute_batch(&format!("ALTER TABLE memories ADD COLUMN {definition}"))
                .unwrap();
        }
        connection
            .execute_batch("UPDATE schema_metadata SET minor=1")
            .unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();

        assert!(store::open(&path).is_err());

        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
