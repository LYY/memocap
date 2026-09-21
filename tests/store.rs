use memocap::scope::ScopeId;
use memocap::store;

fn scope_id(seed: char) -> ScopeId {
    format!("repository:{}", seed.to_string().repeat(64))
        .parse()
        .unwrap()
}

fn remember_scoped(
    connection: &rusqlite::Connection,
    scope: &ScopeId,
    content: &str,
    topic_key: Option<&str>,
    force: bool,
    overwrite_id: Option<i64>,
) -> anyhow::Result<i64> {
    store::remember_scoped(
        connection,
        scope,
        content,
        "note",
        "",
        store::RememberOptions {
            topic_key,
            force,
            overwrite_id,
        },
    )
}

fn dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

fn schema_rows(connection: &rusqlite::Connection) -> Vec<(String, String, String, String)> {
    connection
        .prepare(
            "SELECT type, name, tbl_name, COALESCE(sql, '')
              FROM sqlite_schema
              WHERE name NOT GLOB 'sqlite_*'
              ORDER BY type, name",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn create_exact_pre_versioned_schema(connection: &rusqlite::Connection) {
    connection
        .execute_batch(
            "
            CREATE TABLE memories (
                id INTEGER PRIMARY KEY,
                content TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'context',
                tags TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                scope TEXT NOT NULL DEFAULT 'global',
                topic_key TEXT NOT NULL DEFAULT ''
            );
            CREATE VIRTUAL TABLE memories_fts USING fts5(
                content, tags, content='memories', content_rowid='id'
            );
            CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
            END;
            CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content, tags)
                VALUES ('delete', old.id, old.content, old.tags);
            END;
            CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
                INSERT INTO memories_fts(memories_fts, rowid, content, tags)
                VALUES ('delete', old.id, old.content, old.tags);
                INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
            END;
            INSERT INTO memories (id, content, kind, tags, created_at, updated_at, scope, topic_key)
            VALUES (7, 'legacy searchable value', 'note', '', 'before', 'before', 'global', '');
            ",
        )
        .unwrap();
}

#[test]
fn save() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let id = store::remember(&c, "alpha", "note", "t1", "global", false, None).unwrap();
    assert!(id > 0);
    assert_eq!(store::count(&c).unwrap(), 1);
}

#[test]
fn query() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    store::remember(&c, "alpha beta", "note", "", "global", false, None).unwrap();
    let found = store::recall(&c, "alpha", 5, None, None).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, "note");
}

#[test]
fn list_newest() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let a = store::remember(&c, "first", "note", "", "global", false, None).unwrap();
    let b = store::remember(&c, "second", "note", "", "global", false, None).unwrap();
    let listed = store::list(&c, 20).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, b);
    assert_eq!(listed[1].id, a);
}

#[test]
fn delete_target() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let keep = store::remember(&c, "keep", "note", "", "global", false, None).unwrap();
    let drop = store::remember(&c, "drop", "note", "", "global", false, None).unwrap();
    assert!(store::forget(&c, drop).unwrap());
    assert!(!store::forget(&c, drop).unwrap());
    let listed = store::list(&c, 20).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, keep);
}

#[test]
fn empty_store() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    assert!(store::list(&c, 20).unwrap().is_empty());
    assert_eq!(store::count(&c).unwrap(), 0);
}

#[test]
fn no_result() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    store::remember(&c, "only rust sqlite", "note", "", "global", false, None).unwrap();
    assert!(store::recall(&c, "python chroma", 5, None, None)
        .unwrap()
        .is_empty());
    assert!(store::recall(&c, "   ", 5, None, None).unwrap().is_empty());
}

#[test]
fn similar_skips_insert_without_force() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let id = store::remember(&c, "alpha beta", "note", "", "global", false, None).unwrap();
    let err = store::remember(&c, "alpha beta", "note", "", "global", false, None).unwrap_err();
    let similar = err.downcast_ref::<store::SimilarMemories>().unwrap();
    assert_eq!(similar.candidates.len(), 1);
    assert_eq!(similar.candidates[0].id, id);
    assert_eq!(similar.candidates[0].content, "alpha beta");
    assert!(err.to_string().contains("pass --force"));
    assert_eq!(store::count(&c).unwrap(), 1);
}

#[test]
fn force_inserts_anyway() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    store::remember(&c, "alpha beta", "note", "", "global", false, None).unwrap();
    let id = store::remember(&c, "alpha beta", "note", "", "global", true, None).unwrap();
    assert!(id > 0);
    assert_eq!(store::count(&c).unwrap(), 2);
}

#[test]
fn recall_default_limit_is_three() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    for _ in 0..5 {
        store::remember(&c, "shared token", "note", "", "global", true, None).unwrap();
    }
    assert_eq!(store::DEFAULT_RECALL_LIMIT, 3);
    let found = store::recall(&c, "shared token", store::DEFAULT_RECALL_LIMIT, None, None).unwrap();
    assert_eq!(found.len(), 3);
}

#[test]
fn recall_kind_filter() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    store::remember(&c, "alpha note item", "note", "", "global", false, None).unwrap();
    store::remember(
        &c,
        "alpha pref item",
        "preference",
        "",
        "global",
        false,
        None,
    )
    .unwrap();
    let notes = store::recall(&c, "alpha", 10, Some("note"), None).unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].kind, "note");
    let prefs = store::recall(&c, "alpha", 10, Some("preference"), None).unwrap();
    assert_eq!(prefs.len(), 1);
    assert_eq!(prefs[0].kind, "preference");
}

#[test]
fn overwrite_by_id() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let id = store::remember(&c, "old", "note", "", "global", false, None).unwrap();
    let saved = store::remember(&c, "new", "note", "t", "global", false, Some(id)).unwrap();
    assert_eq!(saved, id);
    assert_eq!(store::count(&c).unwrap(), 1);
    assert_eq!(store::list(&c, 20).unwrap()[0].content, "new");
}

#[test]
fn scopes_isolate_records_while_preserving_global_visibility() {
    // Given
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let global = ScopeId::global();
    let alpha = scope_id('a');
    let beta = scope_id('b');
    let global_id = remember_scoped(&c, &global, "shared global record", None, true, None).unwrap();
    let alpha_id = remember_scoped(&c, &alpha, "same content", None, false, None).unwrap();
    let beta_id = remember_scoped(&c, &beta, "same content", None, false, None).unwrap();

    // When
    let alpha_list = store::list_scoped(&c, &alpha, 20).unwrap();
    let beta_list = store::list_scoped(&c, &beta, 20).unwrap();
    let alpha_recall = store::recall_scoped(&c, &alpha, "content", 20, None, None).unwrap();
    let beta_recall = store::recall_scoped(&c, &beta, "content", 20, None, None).unwrap();

    // Then
    assert_eq!(
        alpha_list
            .iter()
            .map(|memory| memory.id)
            .collect::<Vec<_>>(),
        vec![alpha_id, global_id]
    );
    assert_eq!(
        beta_list.iter().map(|memory| memory.id).collect::<Vec<_>>(),
        vec![beta_id, global_id]
    );
    assert_eq!(
        alpha_recall
            .iter()
            .map(|memory| memory.id)
            .collect::<Vec<_>>(),
        vec![alpha_id]
    );
    assert_eq!(
        beta_recall
            .iter()
            .map(|memory| memory.id)
            .collect::<Vec<_>>(),
        vec![beta_id]
    );
    assert_eq!(store::count_scoped(&c, &alpha).unwrap(), 2);
    assert_eq!(store::count_scoped(&c, &beta).unwrap(), 2);
    assert_eq!(store::count_scoped(&c, &global).unwrap(), 1);
}

#[test]
fn scoped_duplicate_and_destructive_operations_cannot_cross_scope() {
    // Given
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let alpha = scope_id('a');
    let beta = scope_id('b');
    let alpha_id = remember_scoped(&c, &alpha, "same content", None, false, None).unwrap();
    let beta_id = remember_scoped(&c, &beta, "same content", None, false, None).unwrap();

    // When
    let duplicate = remember_scoped(&c, &beta, "same content", None, false, None).unwrap_err();
    let overwrite = remember_scoped(&c, &beta, "changed", None, true, Some(alpha_id));
    let deleted = store::forget_scoped(&c, &beta, alpha_id).unwrap();

    // Then
    assert_eq!(
        duplicate
            .downcast_ref::<store::SimilarMemories>()
            .unwrap()
            .candidates
            .iter()
            .map(|memory| memory.id)
            .collect::<Vec<_>>(),
        vec![beta_id]
    );
    assert!(overwrite.is_err());
    assert!(!deleted);
    assert_eq!(
        store::list_scoped(&c, &alpha, 20).unwrap()[0].content,
        "same content"
    );
}

#[test]
fn recall_shadows_global_topics_before_limit_and_character_budget() {
    // Given
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let global = ScopeId::global();
    let alpha = scope_id('a');
    let global_id = remember_scoped(
        &c,
        &global,
        "global result with many characters",
        Some(" status "),
        true,
        None,
    )
    .unwrap();
    let alpha_id = remember_scoped(&c, &alpha, "local result", Some("status"), true, None).unwrap();
    remember_scoped(&c, &global, "unkeyed global result", None, true, None).unwrap();

    // When
    let recalled = store::recall_scoped(&c, &alpha, "result", 1, None, Some(12)).unwrap();
    let all_recalled = store::recall_scoped(&c, &alpha, "result", 20, None, None).unwrap();
    let listed = store::list_scoped(&c, &alpha, 20).unwrap();

    // Then
    assert_eq!(
        recalled.iter().map(|memory| memory.id).collect::<Vec<_>>(),
        vec![alpha_id]
    );
    assert_eq!(recalled[0].topic_key, "status");
    assert!(!all_recalled.iter().any(|memory| memory.id == global_id));
    assert!(listed.iter().any(|memory| memory.id == global_id));
    assert_eq!(store::count_scoped(&c, &alpha).unwrap(), 3);
}

#[test]
fn topic_key_normalizes_unicode_whitespace_and_case() {
    let topic = "\u{2003}RÜST\u{00A0}\tİSTANBUL\u{3000} Σ\u{2002}";

    assert_eq!(
        store::normalize_topic_key(Some(topic)).as_deref(),
        Some("rüst i\u{0307}stanbul σ")
    );
}

#[test]
fn unicode_equivalent_scoped_topic_shadows_global_recall() {
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let global = ScopeId::global();
    let repository = scope_id('a');
    let global_id = remember_scoped(
        &c,
        &global,
        "global unicode topic result",
        Some("\u{2003}RÜST\u{00A0}\tİSTANBUL\u{3000} Σ\u{2002}"),
        true,
        None,
    )
    .unwrap();
    let repository_id = remember_scoped(
        &c,
        &repository,
        "repository unicode topic result",
        Some("rüst i\u{0307}stanbul σ"),
        true,
        None,
    )
    .unwrap();

    let recalled = store::recall_scoped(&c, &repository, "result", 20, None, None).unwrap();

    assert!(recalled.iter().any(|memory| memory.id == repository_id));
    assert!(!recalled.iter().any(|memory| memory.id == global_id));
}

#[test]
fn empty_topics_do_not_shadow_and_overwrite_preserves_or_clears_topic() {
    // Given
    let d = dir();
    let c = store::open(&d.path().join("db")).unwrap();
    let global = ScopeId::global();
    let alpha = scope_id('a');
    remember_scoped(&c, &global, "global result", Some("topic"), true, None).unwrap();
    let id = remember_scoped(&c, &alpha, "local result", Some("topic"), true, None).unwrap();
    remember_scoped(&c, &alpha, "local unkeyed result", Some("  "), true, None).unwrap();

    // When
    remember_scoped(&c, &alpha, "local updated result", None, true, Some(id)).unwrap();
    let preserved = store::list_scoped(&c, &alpha, 20).unwrap();
    remember_scoped(
        &c,
        &alpha,
        "local cleared result",
        Some("  "),
        true,
        Some(id),
    )
    .unwrap();
    let recalled = store::recall_scoped(&c, &alpha, "result", 20, None, None).unwrap();

    // Then
    assert_eq!(
        preserved
            .iter()
            .find(|memory| memory.id == id)
            .unwrap()
            .topic_key,
        "topic"
    );
    assert_eq!(
        recalled
            .iter()
            .filter(|memory| memory.topic_key == "topic")
            .count(),
        1
    );
    assert!(recalled
        .iter()
        .any(|memory| memory.id == id && memory.topic_key.is_empty()));
}

#[test]
fn creates_and_reopens_exact_schema_1_0() {
    // Given
    let d = dir();
    let database = d.path().join("db");

    // When
    let (created, created_lifecycle) = store::open_with_lifecycle(&database).unwrap();
    drop(created);
    let (reopened, reopened_lifecycle) = store::open_with_lifecycle(&database).unwrap();

    // Then
    assert_eq!(created_lifecycle, store::SchemaLifecycle::Created);
    assert_eq!(reopened_lifecycle, store::SchemaLifecycle::Opened);
    assert_eq!(
        reopened
            .query_row("SELECT major, minor FROM schema_metadata", [], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap(),
        (1, 0)
    );
    assert_eq!(
        reopened
            .query_row("SELECT COUNT(*) FROM schema_metadata", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn resets_exact_pre_versioned_schema_to_empty_1_0() {
    // Given
    let d = dir();
    let database = d.path().join("db");
    let legacy = rusqlite::Connection::open(&database).unwrap();
    create_exact_pre_versioned_schema(&legacy);
    drop(legacy);

    // When
    let (connection, lifecycle) = store::open_with_lifecycle(&database).unwrap();

    // Then
    assert_eq!(lifecycle, store::SchemaLifecycle::ResetPreVersioned);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT major, minor FROM schema_metadata", [], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap(),
        (1, 0)
    );
    assert!(!database.with_extension("bak").exists());
}

#[test]
fn refuses_unknown_schema_shape_without_mutation() {
    // Given
    let d = dir();
    let database = d.path().join("db");
    let legacy = rusqlite::Connection::open(&database).unwrap();
    create_exact_pre_versioned_schema(&legacy);
    legacy
        .execute_batch("CREATE TABLE unknown_shape (id INTEGER PRIMARY KEY)")
        .unwrap();
    let before = schema_rows(&legacy);
    drop(legacy);

    // When
    let failure = store::open_with_lifecycle(&database);

    // Then
    assert!(failure.is_err());
    let unchanged = rusqlite::Connection::open(&database).unwrap();
    assert_eq!(schema_rows(&unchanged), before);
    assert_eq!(
        unchanged
            .query_row("SELECT content FROM memories WHERE id = 7", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "legacy searchable value"
    );
}

#[test]
fn refuses_pre_versioned_schema_with_sqlite_x_user_table_without_mutation() {
    // Given
    let d = dir();
    let database = d.path().join("db");
    let legacy = rusqlite::Connection::open(&database).unwrap();
    create_exact_pre_versioned_schema(&legacy);
    legacy
        .execute_batch(
            "
            CREATE TABLE sqliteXunexpected (marker TEXT NOT NULL);
            INSERT INTO sqliteXunexpected (marker) VALUES ('do not reset');
            ",
        )
        .unwrap();
    let before = schema_rows(&legacy);
    drop(legacy);

    // When
    let failure = store::open_with_lifecycle(&database);

    // Then
    assert!(failure.is_err());
    let unchanged = rusqlite::Connection::open(&database).unwrap();
    assert_eq!(schema_rows(&unchanged), before);
    assert_eq!(
        unchanged
            .query_row("SELECT content FROM memories WHERE id = 7", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "legacy searchable value"
    );
    assert_eq!(
        unchanged
            .query_row("SELECT marker FROM sqliteXunexpected", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "do not reset"
    );
}

#[test]
fn refuses_changed_current_schema_fingerprint_without_mutation() {
    // Given
    let d = dir();
    let database = d.path().join("db");
    let (connection, _) = store::open_with_lifecycle(&database).unwrap();
    let sentinel = store::remember(
        &connection,
        "current schema sentinel",
        "note",
        "",
        "global",
        true,
        None,
    )
    .unwrap();
    connection
        .execute_batch(
            "
            DROP TABLE operation_ledger;
            CREATE TABLE operation_ledger (operation_id TEXT PRIMARY KEY);
            ",
        )
        .unwrap();
    let before = schema_rows(&connection);
    drop(connection);

    // When
    let failure = store::open_with_lifecycle(&database);

    // Then
    assert!(failure.is_err());
    let unchanged = rusqlite::Connection::open(&database).unwrap();
    assert_eq!(schema_rows(&unchanged), before);
    assert_eq!(
        unchanged
            .query_row(
                "SELECT content FROM memories WHERE id = ?1",
                [sentinel],
                |row| { row.get::<_, String>(0) }
            )
            .unwrap(),
        "current schema sentinel"
    );
}

#[test]
fn refuses_future_schema_versions_without_mutation() {
    // Given
    let d = dir();
    let database = d.path().join("db");
    let (connection, _) = store::open_with_lifecycle(&database).unwrap();
    let sentinel = store::remember(
        &connection,
        "future schema sentinel",
        "note",
        "",
        "global",
        true,
        None,
    )
    .unwrap();
    connection
        .execute("UPDATE schema_metadata SET major = 1, minor = 1", [])
        .unwrap();
    let higher_minor = (
        schema_rows(&connection),
        (1, 1),
        connection
            .query_row(
                "SELECT content FROM memories WHERE id = ?1",
                [sentinel],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    );
    drop(connection);

    // When
    let higher_minor_failure = store::open_with_lifecycle(&database);
    let unchanged = rusqlite::Connection::open(&database).unwrap();
    let after_higher_minor = (
        schema_rows(&unchanged),
        unchanged
            .query_row("SELECT major, minor FROM schema_metadata", [], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap(),
        unchanged
            .query_row(
                "SELECT content FROM memories WHERE id = ?1",
                [sentinel],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    );
    unchanged
        .execute("UPDATE schema_metadata SET major = 2, minor = 0", [])
        .unwrap();
    let unknown_major = (
        schema_rows(&unchanged),
        (2, 0),
        unchanged
            .query_row(
                "SELECT content FROM memories WHERE id = ?1",
                [sentinel],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    );
    drop(unchanged);
    let unknown_major_failure = store::open_with_lifecycle(&database);

    // Then
    assert!(higher_minor_failure.is_err());
    assert_eq!(after_higher_minor, higher_minor);
    assert!(unknown_major_failure.is_err());
    let unchanged = rusqlite::Connection::open(&database).unwrap();
    assert_eq!(
        (
            schema_rows(&unchanged),
            unchanged
                .query_row("SELECT major, minor FROM schema_metadata", [], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })
                .unwrap(),
            unchanged
                .query_row(
                    "SELECT content FROM memories WHERE id = ?1",
                    [sentinel],
                    |row| { row.get::<_, String>(0) }
                )
                .unwrap(),
        ),
        unknown_major
    );
}

#[test]
fn refuses_malformed_schema_metadata_without_mutation() {
    // Given
    let d = dir();
    let database = d.path().join("db");
    let (connection, _) = store::open_with_lifecycle(&database).unwrap();
    connection
        .execute("DELETE FROM schema_metadata", [])
        .unwrap();
    let before = schema_rows(&connection);
    drop(connection);

    // When
    let failure = store::open_with_lifecycle(&database);

    // Then
    assert!(failure.is_err());
    let unchanged = rusqlite::Connection::open(&database).unwrap();
    assert_eq!(schema_rows(&unchanged), before);
    assert_eq!(
        unchanged
            .query_row("SELECT COUNT(*) FROM schema_metadata", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
